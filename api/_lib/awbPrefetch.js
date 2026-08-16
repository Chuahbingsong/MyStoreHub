import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';
import {
  createShippingDocumentsWithTypeFallback,
  downloadShippingDocument,
  ensureFreshToken,
  waitForDocumentReady,
} from './shopeeAwb.js';
// Fingerprint, bucket and path now live in awbCache.js so the print path
// reads the cache with exactly the definitions prefetch wrote it with.
// Re-exported here so this module's existing public surface is unchanged.
import { AWB_BUCKET, awbCacheFingerprint, awbStoragePath } from './awbCache.js';

export { AWB_BUCKET, awbCacheFingerprint, awbStoragePath };

// Hard ceiling on orders touched per store per run. The real limiter is the
// deadline check inside the loop — this just bounds the candidate query so a
// large backlog can't pull an enormous page it has no hope of working
// through. Raised from 10 once prefetch moved out of the main cron: it now
// owns a whole 60s invocation instead of competing with order sync for the
// tail end of one.
export const MAX_PREFETCH_PER_RUN = 25;

// Below this much remaining budget, do nothing at all rather than start work
// that cannot finish — a create call with no time left to download still
// costs a Shopee document and an attempt stamp. Needs to cover create + poll
// + at least one download (~3.5s measured) with margin. Lowered from 15s
// alongside the move: with a dedicated function this gate is about spending
// the tail of the window sensibly, not about yielding to other work.
export const PREFETCH_MIN_REMAINING_MS = 8_000;

// A stamped-but-uncached order is retried no sooner than this. Long enough
// that a persistently failing order can't burn the cap every tick, short
// enough that a transient Shopee failure recovers within the hour.
export const PREFETCH_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

// 2 instead of the print path's 5. Each extra attempt costs a fixed 2s sleep.
// Measured data has the document READY on the first poll, so this mainly
// bounds the pathological case — kept low even with the roomier budget, since
// a stuck document is better retried next run than waited on for 8s here.
export const PREFETCH_POLL_RETRIES = 2;

// Rough per-order download cost, used to decide whether there is time for one
// more order before the deadline. Deliberately pessimistic.
const ESTIMATED_DOWNLOAD_MS = 2500;

// Same shape as makePerfTracker in shopeeAwb.js, but logged under the
// prefetch's own prefix so cron output stays readable.
function makePrefetchPerf() {
  return {
    start(label) {
      const t = Date.now();
      return () => {
        const ms = Date.now() - t;
        console.log(`[awb-prefetch][perf] ${label}: ${ms}ms`);
        return ms;
      };
    },
    summary() {},
  };
}

/**
 * Marks orders as attempted BEFORE any Shopee call is made for them. A hard
 * Vercel timeout kills the process with no chance to run a catch block, so
 * stamping afterwards would leave the same orders eligible forever and let
 * them burn the cap on every subsequent tick.
 */
async function stampAttempted(orderIds) {
  const { error } = await supabaseAdmin
    .from('orders')
    .update({ awb_prefetch_attempted_at: new Date().toISOString() })
    .in('id', orderIds);

  if (error) {
    console.error('[awb-prefetch] failed to stamp attempted_at', error);
  }
}

/**
 * Uploads one order's PDF and records where it went. Returns true only if
 * both the upload and the row update succeeded — a path written without bytes
 * behind it would be worse than no cache at all.
 */
async function storeAwbPdf(order, storeId, pdfBuffer) {
  const path = awbStoragePath(storeId, order.platform_order_id);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AWB_BUCKET)
    .upload(path, pdfBuffer, {
      contentType: 'application/pdf',
      // A regenerated label for the same order must replace the old one.
      upsert: true,
    });

  if (uploadError) {
    console.error(`[awb-prefetch] upload failed for ${order.platform_order_id}:`, uploadError.message);
    return false;
  }

  const { error: updateError } = await supabaseAdmin
    .from('orders')
    .update({
      awb_cached_path: path,
      awb_cached_at: new Date().toISOString(),
      awb_cache_fingerprint: awbCacheFingerprint(order),
    })
    .eq('id', order.id);

  if (updateError) {
    console.error(
      `[awb-prefetch] uploaded ${path} but failed to record it on the order:`,
      updateError.message
    );
    return false;
  }

  console.log(`[awb-prefetch] cached ${order.platform_order_id} -> ${path} (${pdfBuffer.length} bytes)`);
  return true;
}

/**
 * Shopee refuses to put different logistics channels in one document, so
 * create/poll are batched per courier exactly like the Bulk Print page does.
 */
function groupByCourier(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = order.courier_name || '(no courier)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return [...groups.entries()];
}

/**
 * Generates and caches AWB PDFs for one store's PROCESSED orders.
 *
 * Only orders that already have a tracking_number are considered. This is a
 * deliberate addition to the stated candidate rules: create_shipping_document
 * validates tracking_number and fails without one, so including those orders
 * would spend Shopee calls and an attempt stamp to achieve nothing. The
 * backfillTrackingNumbers pass in shopeeSync.js (main cron) fills them in,
 * after which they become prefetch candidates on a later prefetch run.
 *
 * Documents are created and polled per courier batch (cheap, one call each)
 * but downloaded per order, because the cache is keyed per order SN — a
 * combined PDF would hand someone printing one order everyone else's labels.
 *
 * options.deadline: the absolute cutoff for starting new work, shared across
 * every store in the invocation (see api/cron/prefetch-awb.js). Stores run
 * concurrently, so this bounds wall-clock time, not the sum of their work.
 */
export async function prefetchStoreAwbs(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;
  const remaining = deadline - Date.now();

  if (remaining <= PREFETCH_MIN_REMAINING_MS) {
    console.log(
      `[awb-prefetch] [${store.id}] only ${remaining}ms left (need >${PREFETCH_MIN_REMAINING_MS}ms), deferring to next run`
    );
    return { storeId: store.id, cached: 0, attempted: 0, deferred: true };
  }

  const canProceed = await acquireSyncLock(store.id, 'awb_prefetch');
  if (!canProceed) {
    console.log(`[awb-prefetch] [${store.id}] already in progress elsewhere, skipping`);
    return { storeId: store.id, cached: 0, attempted: 0, locked: true };
  }

  const cooldownCutoff = new Date(Date.now() - PREFETCH_RETRY_COOLDOWN_MS).toISOString();

  const { data: candidates, error: queryError } = await supabaseAdmin
    .from('orders')
    .select('id, platform_order_id, tracking_number, order_status, courier_name, shipping_address')
    .eq('store_id', store.id)
    .eq('platform', 'shopee')
    .eq('order_status', 'PROCESSED')
    .is('awb_cached_path', null)
    .not('tracking_number', 'is', null)
    .or(`awb_prefetch_attempted_at.is.null,awb_prefetch_attempted_at.lt.${cooldownCutoff}`)
    .order('order_created_at', { ascending: true })
    .limit(MAX_PREFETCH_PER_RUN);

  if (queryError) {
    console.error('[awb-prefetch] failed to load candidates for store', store.id, queryError);
    return { storeId: store.id, cached: 0, attempted: 0, error: queryError.message };
  }

  if (!candidates || candidates.length === 0) {
    return { storeId: store.id, cached: 0, attempted: 0 };
  }

  const groups = groupByCourier(candidates);
  console.log(
    `[awb-prefetch] [${store.id}] ${candidates.length} candidate(s) across ${groups.length} courier group(s), ${remaining}ms budget`
  );

  const perf = makePrefetchPerf();
  const freshStore = await ensureFreshToken(store);

  let cached = 0;
  let attempted = 0;

  for (const [courier, group] of groups) {
    if (Date.now() + ESTIMATED_DOWNLOAD_MS >= deadline) {
      console.log(
        `[awb-prefetch] [${store.id}] out of budget, stopping before courier "${courier}" (${groups.length} group(s) total)`
      );
      break;
    }

    const orderSns = group.map((o) => o.platform_order_id);
    const trackingByOrderSn = Object.fromEntries(
      group.map((o) => [o.platform_order_id, o.tracking_number])
    );

    // Stamped before the first Shopee call for this group, not after.
    await stampAttempted(group.map((o) => o.id));
    attempted += group.length;

    const logId = await logSyncStart(store.id, 'awb_prefetch');

    try {
      const { created, typeByOrderSn } = await createShippingDocumentsWithTypeFallback(
        freshStore,
        orderSns,
        trackingByOrderSn,
        perf
      );

      const { ready } = await waitForDocumentReady(
        freshStore,
        created,
        typeByOrderSn,
        perf,
        PREFETCH_POLL_RETRIES
      );

      const readySet = new Set(ready);
      let groupCached = 0;

      for (const order of group) {
        if (!readySet.has(order.platform_order_id)) continue;

        // Re-checked per order: each download is a fresh ~2.5s commitment and
        // the group may have several.
        if (Date.now() + ESTIMATED_DOWNLOAD_MS >= deadline) {
          console.log(
            `[awb-prefetch] [${store.id}] budget reached mid-group; ${order.platform_order_id} left for next run`
          );
          break;
        }

        try {
          const downloadDone = perf.start(`download[${order.platform_order_id}]`);
          const pdfBuffer = await downloadShippingDocument(freshStore, [order.platform_order_id]);
          downloadDone();

          if (await storeAwbPdf(order, store.id, pdfBuffer)) {
            cached += 1;
            groupCached += 1;
          }
        } catch (err) {
          // One bad order must not sink the rest of the group. It stays
          // uncached and is retried after the cooldown.
          console.error(
            `[awb-prefetch] [${store.id}] download failed for ${order.platform_order_id}:`,
            err.message
          );
        }
      }

      await logSyncComplete(
        logId,
        'success',
        `Prefetched ${groupCached}/${group.length} label(s) for courier "${courier}"`
      );
    } catch (err) {
      console.error(`[awb-prefetch] [${store.id}] courier "${courier}" failed:`, err.message);
      if (err.shopeeResponse) {
        console.error('[awb-prefetch] full Shopee response:');
        console.error(JSON.stringify(err.shopeeResponse, null, 2));
      }
      await logSyncComplete(logId, 'error', `Prefetch failed for courier "${courier}": ${err.message}`);
    }
  }

  console.log(`[awb-prefetch] [${store.id}] done: ${cached}/${attempted} cached`);
  return { storeId: store.id, cached, attempted };
}
