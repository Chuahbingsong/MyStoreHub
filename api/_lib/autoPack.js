import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';
import {
  ensureFreshToken,
  shipOrder,
  ShopeeStepError,
  IncompleteShippingInfoError,
  PickupRequiresManualError,
} from './shopeeShip.js';

// A buyer who cancels an order BEFORE shipment is arranged gets an automatic,
// no-penalty cancellation on Shopee's side. Arranging shipment closes that
// window instantly. This delay leaves it open for a while even when
// auto-pack is on, at effectively no cost (packing 15 minutes later doesn't
// matter operationally).
export const AUTO_PACK_MIN_AGE_MS = 15 * 60 * 1000;

// Caps how many orders one run touches per store, so a backlog (e.g.
// auto-pack just turned on with 200 READY_TO_SHIP orders sitting around)
// can't blow the cron time budget or hammer Shopee's ship_order endpoint.
export const MAX_AUTO_PACK_PER_RUN = 10;

// How many candidates to pull before the age filter narrows them to
// MAX_AUTO_PACK_PER_RUN. Bounded so the query can never silently hit
// PostgREST's 1000-row cap; ample, since only the oldest handful are ever used.
const AUTO_PACK_CANDIDATE_LIMIT = 200;

async function markAttempt(orderId, patch) {
  const { error } = await supabaseAdmin
    .from('orders')
    .update({ auto_pack_attempted_at: new Date().toISOString(), ...patch })
    .eq('id', orderId);

  if (error) {
    console.error('[auto-pack] failed to record attempt on order', orderId, error);
  }
}

/**
 * Auto-packs eligible READY_TO_SHIP orders for one store: ship_order only,
 * nothing else. Every attempt is logged to sync_logs (started + result) and
 * every order is touched at most once ever — auto_pack_status IS NULL is the
 * only eligibility gate, and it's set to a terminal value ('success',
 * 'failed', or 'skipped') on the first attempt no matter the outcome, so a
 * failure never retries on the next tick. The manual Pack button remains a
 * human's fallback regardless of auto_pack_status.
 *
 * options.deadline: shares the caller's existing per-store time budget —
 * this does not get its own fresh window.
 */
export async function autoPackStore(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;

  const canProceed = await acquireSyncLock(store.id, 'auto_pack');
  if (!canProceed) {
    console.log(`[auto-pack] [${store.id}] already in progress elsewhere, skipping`);
    return { storeId: store.id, attempted: 0, packed: 0, locked: true };
  }

  // The READY_TO_SHIP + untouched-by-auto-pack set is a live backlog, not
  // order history — bounded and small in practice — so it's fetched whole
  // and filtered/sorted here in JS rather than pushing the age check into
  // the query.
  //
  // paid_at is null on ~15% of all orders (confirmed against production
  // data: null across many payment methods, not one edge case, and never
  // backfilled once Shopee's own pay_time comes back empty) — filtering in
  // SQL on `paid_at <= cutoff` would silently and permanently drop every one
  // of those orders from auto-pack with no error and no log line. order_
  // created_at is populated on 100% of orders, so it's the fallback instead
  // of a second column that can also go silently missing. Confirmed nothing
  // else in this file, or the UI badges/terminal gate, keys on paid_at —
  // this fallback is scoped to the age check alone.
  // Explicitly ordered and bounded. Previously neither: an unordered, unbounded
  // select would let PostgREST's 1000-row cap pick an ARBITRARY thousand once a
  // store's pending backlog grew past it, so which orders got packed first was
  // undefined. Oldest-first is the intended fairness rule, and the cap is a
  // generous multiple of MAX_AUTO_PACK_PER_RUN since only the oldest few
  // survive the age filter below anyway.
  const { data: candidates, error: queryError } = await supabaseAdmin
    .from('orders')
    .select('id, platform_order_id, paid_at, order_created_at, buyer_message')
    .eq('store_id', store.id)
    .eq('order_status', 'READY_TO_SHIP')
    .is('auto_pack_status', null)
    .order('order_created_at', { ascending: true })
    .limit(AUTO_PACK_CANDIDATE_LIMIT);

  if (queryError) {
    console.error('[auto-pack] failed to load candidate orders for store', store.id, queryError);
    return { storeId: store.id, attempted: 0, packed: 0, error: queryError.message };
  }

  // A buyer who left a checkout note may be asking for something packing
  // can't decide on its own (a substitution, a gift wrap, a delivery
  // instruction) — those need a human to actually read the note. Stamped
  // terminal immediately, same as any other permanent skip reason, rather
  // than waiting out the age filter below: there's nothing time-dependent
  // about needing a human to read a message.
  const hasBuyerMessage = (order) =>
    typeof order.buyer_message === 'string' && order.buyer_message.trim().length > 0;

  const withBuyerMessage = (candidates ?? []).filter(hasBuyerMessage);
  if (withBuyerMessage.length > 0) {
    console.log(`[auto-pack] [${store.id}] ${withBuyerMessage.length} order(s) skipped: buyer left a message`);
    for (const order of withBuyerMessage) {
      await markAttempt(order.id, { auto_pack_status: 'skipped', auto_pack_error: 'has_buyer_message' });
    }
  }

  const now = Date.now();
  const eligible = (candidates ?? [])
    .filter((order) => !hasBuyerMessage(order))
    .map((order) => ({
      order,
      effectiveTime: new Date(order.paid_at ?? order.order_created_at).getTime(),
    }))
    .filter(({ effectiveTime }) => now - effectiveTime >= AUTO_PACK_MIN_AGE_MS)
    .sort((a, b) => a.effectiveTime - b.effectiveTime)
    .slice(0, MAX_AUTO_PACK_PER_RUN)
    .map(({ order }) => order);

  if (eligible.length === 0) {
    return { storeId: store.id, attempted: 0, packed: 0 };
  }

  console.log(`[auto-pack] [${store.id}] ${eligible.length} eligible order(s) this run`);

  const freshStore = await ensureFreshToken(store);

  let packed = 0;
  let attempted = 0;

  for (const order of eligible) {
    if (Date.now() >= deadline) {
      console.warn(`[auto-pack] [${store.id}] time budget reached, stopping (${eligible.length - attempted} order(s) left for next run)`);
      break;
    }

    attempted += 1;
    const orderSn = order.platform_order_id;
    const logId = await logSyncStart(store.id, 'auto_pack');

    try {
      // allowIncomplete defaults to false: if info_needed requires a field we
      // can't fill (e.g. a non_integrated channel's seller-supplied
      // tracking_number), skip this order rather than send a doomed request —
      // no one is present to notice ship_order failed.
      const { method } = await shipOrder(freshStore, orderSn);

      await supabaseAdmin
        .from('orders')
        .update({
          order_status: 'PROCESSED',
          packed_at: new Date().toISOString(),
          packed_by: 'auto',
          shipping_method: method,
          auto_pack_status: 'success',
          auto_pack_attempted_at: new Date().toISOString(),
          auto_pack_error: null,
        })
        .eq('id', order.id);

      await logSyncComplete(logId, 'success', `Auto-packed ${orderSn} via ${method ?? '(unknown method)'}`);
      packed += 1;
    } catch (err) {
      const isPickupBlock = err instanceof PickupRequiresManualError;
      const skipped = err instanceof IncompleteShippingInfoError || isPickupBlock;
      const status = skipped ? 'skipped' : 'failed';
      const shopeeResponse = err instanceof ShopeeStepError ? err.shopeeResponse : null;

      console.error(`[auto-pack] [${store.id}] ${status} for ${orderSn}:`, err.message);
      if (shopeeResponse) console.error(JSON.stringify(shopeeResponse, null, 2));

      // Distinct auto_pack_error prefix so pickup-needs-a-human skips are
      // greppable/filterable separately from incomplete-shipping-info skips.
      const autoPackError = isPickupBlock ? `pickup_requires_manual: ${err.message}` : err.message;
      await markAttempt(order.id, { auto_pack_status: status, auto_pack_error: autoPackError });
      await logSyncComplete(
        logId,
        status === 'skipped' ? 'success' : 'error',
        `Auto-pack ${status} for ${orderSn}: ${err.message}`
      );
    }
  }

  console.log(`[auto-pack] [${store.id}] done: ${packed}/${attempted} packed`);
  return { storeId: store.id, attempted, packed };
}
