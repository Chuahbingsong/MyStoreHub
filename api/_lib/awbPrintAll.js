import { supabaseAdmin } from './supabaseAdmin.js';
import { cacheEligibility } from './awbCache.js';
import { fetchCachedPdfs, mergePdfBuffers, sortForMerge } from './awbMerge.js';
import {
  createShippingDocumentsWithTypeFallback,
  downloadShippingDocument,
  ensureFreshToken,
  makePerfTracker,
  persistTrackingNumbers,
  resolveTrackingNumbers,
  waitForDocumentReady,
} from './shopeeAwb.js';

// --- Print All Unprinted -----------------------------------------------------
//
// One merged PDF covering every PROCESSED, not-yet-printed Shopee order across
// all of a user's stores.
//
// Unlike the per-store print paths, this one DOES mix cached and freshly
// generated labels in a single document. That is the point of the feature: the
// operator wants one file for the whole backlog, and refusing to mix would mean
// regenerating labels already sitting in Storage.

// Ceiling on how many orders one press can print. Past this the rest are
// reported back so the user knows to press again, rather than the function
// being killed partway through a 60s merge.
export const MAX_PRINT_ALL_ORDERS = 50;

// Live generation is the slow half (~3.5s per store+courier group). Once this
// much of the window is gone no further groups are started, and their orders
// come back as skipped — a smaller file now beats a timeout.
export const PRINT_ALL_LIVE_BUDGET_MS = 40_000;

/**
 * Runs the live pipeline for one store+courier group, returning the combined
 * PDF Shopee produces plus the orders it actually covers. Throws only on a
 * genuine pipeline failure; the caller treats that as "skip this group"
 * rather than failing the whole sweep.
 */
async function generateLiveGroup(store, orders, perf) {
  const orderSns = orders.map((order) => order.platform_order_id);
  const storedTracking = Object.fromEntries(
    orders.filter((o) => o.tracking_number).map((o) => [o.platform_order_id, o.tracking_number])
  );

  const { trackingByOrderSn, skipped, freshlyFetchedOrderSns } = await resolveTrackingNumbers(
    store,
    storedTracking,
    orderSns,
    perf
  );

  if (freshlyFetchedOrderSns.length > 0) {
    await persistTrackingNumbers(
      store.id,
      Object.fromEntries(freshlyFetchedOrderSns.map((sn) => [sn, trackingByOrderSn[sn]]))
    );
  }

  const printable = orderSns.filter((sn) => trackingByOrderSn[sn]);
  if (printable.length === 0) return { pdf: null, printed: [], skipped };

  const { created, typeByOrderSn } = await createShippingDocumentsWithTypeFallback(
    store,
    printable,
    trackingByOrderSn,
    perf
  );

  const { ready } = await waitForDocumentReady(store, created, typeByOrderSn, perf);
  const pdf = await downloadShippingDocument(store, ready);

  return { pdf, printed: ready, skipped: skipped ?? [] };
}

/**
 * Builds the merged backlog PDF for one user. Returns a plain result object;
 * the HTTP handler turns it into a response.
 */
export async function printAllUnprinted(user) {
  const requestStart = Date.now();
  const perf = makePerfTracker();

  const { data: stores, error: storesError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('user_id', user.id)
    .eq('platform', 'shopee');

  if (storesError) {
    console.error('[print-awb] print-all: failed to load stores', storesError);
    return { httpStatus: 500, body: { success: false, error: 'Failed to load stores' } };
  }

  if (!stores || stores.length === 0) {
    return {
      httpStatus: 200,
      body: {
        success: true,
        pdf_base64: null,
        printed_order_sn_list: [],
        printed_by_store: [],
        failed: [],
        skipped_orders: [],
        remaining_unprinted: 0,
        message: 'No connected Shopee stores.',
      },
    };
  }

  const storeIds = stores.map((s) => s.id);
  const storesById = Object.fromEntries(stores.map((s) => [s.id, s]));

  // Ownership is enforced by scoping to this user's store ids — an order can
  // only enter the sweep through a store the caller owns.
  const { data: allOrders, error: ordersError } = await supabaseAdmin
    .from('orders')
    .select(
      'id, store_id, platform_order_id, tracking_number, order_status, courier_name, shipping_address, order_created_at, awb_cached_path, awb_cache_fingerprint'
    )
    .in('store_id', storeIds)
    .eq('platform', 'shopee')
    .eq('order_status', 'PROCESSED')
    .or('awb_printed.is.null,awb_printed.eq.false')
    .not('platform_order_id', 'is', null);

  if (ordersError) {
    console.error('[print-awb] print-all: failed to load orders', ordersError);
    return { httpStatus: 500, body: { success: false, error: 'Failed to load orders' } };
  }

  const sortedAll = sortForMerge(allOrders ?? []);
  const batch = sortedAll.slice(0, MAX_PRINT_ALL_ORDERS);
  const remaining = sortedAll.length - batch.length;

  if (batch.length === 0) {
    console.log('[print-awb][path] RESULT=print_all_empty');
    return {
      httpStatus: 200,
      body: {
        success: true,
        pdf_base64: null,
        printed_order_sn_list: [],
        printed_by_store: [],
        failed: [],
        skipped_orders: [],
        remaining_unprinted: 0,
        message: 'Nothing to print — every processed order already has its label.',
      },
    };
  }

  const cachedOrders = [];
  const liveOrders = [];
  for (const order of batch) {
    if (cacheEligibility(order).ok) cachedOrders.push(order);
    else liveOrders.push(order);
  }

  console.log(
    `[print-awb] print-all: ${batch.length} order(s) — ${cachedOrders.length} cached, ${liveOrders.length} live, ${remaining} left over`
  );

  const cachedBuffers = await fetchCachedPdfs(cachedOrders);

  // Live orders group per store+courier: Shopee refuses to put different
  // logistics channels in one document.
  const liveGroups = new Map();
  for (const order of liveOrders) {
    const key = `${order.store_id}::${order.courier_name || ''}`;
    if (!liveGroups.has(key)) liveGroups.set(key, []);
    liveGroups.get(key).push(order);
  }

  const livePdfByGroupKey = new Map();
  const printedLiveSns = new Set();
  const skippedOrders = [];
  const liveDeadline = requestStart + PRINT_ALL_LIVE_BUDGET_MS;

  for (const [key, group] of liveGroups) {
    if (Date.now() >= liveDeadline) {
      console.log(`[print-awb] print-all: live budget spent, skipping group ${key}`);
      for (const order of group) {
        skippedOrders.push({
          order_sn: order.platform_order_id,
          reason: 'Ran out of time this run — print again to continue',
        });
      }
      continue;
    }

    const freshStore = await ensureFreshToken(storesById[group[0].store_id]);

    try {
      const { pdf, printed, skipped } = await generateLiveGroup(freshStore, group, perf);
      if (pdf) {
        livePdfByGroupKey.set(key, pdf);
        printed.forEach((sn) => printedLiveSns.add(sn));
      }
      skippedOrders.push(...skipped);
    } catch (err) {
      console.error(`[print-awb] print-all: live group ${key} failed:`, err.message);
      for (const order of group) {
        skippedOrders.push({ order_sn: order.platform_order_id, reason: err.message });
      }
    }
  }

  // Assemble in merge order. Cached labels slot in individually; a live
  // group's combined PDF is emitted at the position of its first order, which
  // keeps couriers contiguous even though its internal page order is Shopee's.
  const pieces = [];
  const printedOrderSns = [];
  const emittedGroups = new Set();

  for (const order of batch) {
    const sn = order.platform_order_id;

    const cached = cachedBuffers.get(sn);
    if (cached) {
      pieces.push(cached);
      printedOrderSns.push(sn);
      continue;
    }

    const key = `${order.store_id}::${order.courier_name || ''}`;
    if (livePdfByGroupKey.has(key)) {
      if (!emittedGroups.has(key)) {
        pieces.push(livePdfByGroupKey.get(key));
        emittedGroups.add(key);
      }
      if (printedLiveSns.has(sn)) {
        printedOrderSns.push(sn);
      } else if (!skippedOrders.some((s) => s.order_sn === sn)) {
        // Its group produced a document, but Shopee did not mark this
        // particular order READY — it is not in the PDF, so it must not be
        // reported as printed, and it must not vanish silently either.
        skippedOrders.push({ order_sn: sn, reason: 'Shopee did not have this label ready' });
      }
      continue;
    }

    if (!skippedOrders.some((s) => s.order_sn === sn)) {
      skippedOrders.push({ order_sn: sn, reason: 'No label could be produced for this order' });
    }
  }

  const mergeStart = Date.now();
  const merged = await mergePdfBuffers(pieces);
  const mergeMs = Date.now() - mergeStart;

  if (!merged || printedOrderSns.length === 0) {
    console.log(
      `[print-awb][path] RESULT=print_all_failed orders=${batch.length} skipped=${skippedOrders.length} total_ms=${Date.now() - requestStart}`
    );
    return {
      httpStatus: 502,
      body: {
        success: false,
        error: 'Could not produce any labels for this batch.',
        skipped_orders: skippedOrders,
        remaining_unprinted: remaining,
      },
    };
  }

  const source =
    cachedBuffers.size > 0 && livePdfByGroupKey.size > 0
      ? 'mixed'
      : livePdfByGroupKey.size > 0
        ? 'live'
        : 'cache';

  console.log(
    `[print-awb][path] RESULT=merge source=${source} scope=print_all orders=${printedOrderSns.length} cached=${cachedBuffers.size} live_groups=${livePdfByGroupKey.size} merge_ms=${mergeMs} bytes=${merged.length} total_ms=${Date.now() - requestStart} skipped=${skippedOrders.length} remaining=${remaining}`
  );

  // Grouped per store so the client can confirm each against the store it
  // belongs to — confirm-awb-printed is scoped to a single store.
  const printedSet = new Set(printedOrderSns);
  const printedByStore = stores
    .map((store) => ({
      store_id: store.id,
      order_sn_list: batch
        .filter((o) => o.store_id === store.id && printedSet.has(o.platform_order_id))
        .map((o) => o.platform_order_id),
    }))
    .filter((entry) => entry.order_sn_list.length > 0);

  return {
    httpStatus: 200,
    body: {
      success: true,
      pdf_base64: merged.toString('base64'),
      printed_order_sn_list: printedOrderSns,
      printed_by_store: printedByStore,
      failed: [],
      skipped_orders: skippedOrders,
      remaining_unprinted: remaining,
      source,
    },
  };
}
