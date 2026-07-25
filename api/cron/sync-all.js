import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { syncStoreOrders, syncStoreProducts } from '../_lib/shopeeSync.js';
import { autoPackStore } from '../_lib/autoPack.js';
import { autoBoostStore } from '../_lib/autoBoost.js';
import { notifyStore } from '../_lib/pushNotify.js';

// Cap the runtime. Vercel Hobby allows up to 60s.
export const config = { maxDuration: 60 };

// Every store is synced CONCURRENTLY (Promise.allSettled below), each with
// its own deadline — not one deadline shared across a sequential loop. That
// used to mean 4 stores sharing a single 45-55s budget could hard-timeout
// mid-loop and leave later stores silently unsynced. Running them in
// parallel means wall-clock time for N stores is bounded by the SLOWEST
// single store, not the sum of all of them, so this budget only needs to
// cover one store's worth of work (with margin for the final response).
const TIME_BUDGET_MS = 50_000;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, misconfigured: true };
  }

  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const querySecret = req.query?.secret;

  const provided = bearer || querySecret;
  return { ok: provided === secret, misconfigured: false };
}

export default async function handler(req, res) {
  const auth = isAuthorized(req);

  if (auth.misconfigured) {
    console.error('[cron/sync-all] CRON_SECRET is not configured');
    return res.status(500).json({ success: false, error: 'CRON_SECRET not configured' });
  }

  if (!auth.ok) {
    console.warn('[cron/sync-all] unauthorized cron request');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const startedAt = Date.now();

  // Service-role client: fetch every active Shopee store across ALL users.
  const { data: stores, error: storesError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'shopee')
    .eq('is_active', true);

  if (storesError) {
    console.error('[cron/sync-all] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    console.log('[cron/sync-all] no active Shopee stores to sync');
    return res.status(200).json({
      success: true,
      stores_synced: 0,
      total_orders: 0,
      total_products: 0,
      errors: [],
    });
  }

  console.log('[cron/sync-all] syncing', stores.length, 'active Shopee store(s) in parallel');

  // Every store gets its OWN orders+products deadline computed from this
  // run's start, not a budget shared across a sequential loop. Because the
  // stores below run concurrently (Promise.allSettled), the wall-clock time
  // for this whole invocation is bounded by the slowest single store, not by
  // N * per-store time — that's what keeps 4 stores inside one 60s cron tick.
  // allSettled (not all) so one store's rejection can't cancel the others'
  // in-flight work or their sync_logs bookkeeping.
  const deadline = startedAt + TIME_BUDGET_MS;

  async function syncOneStore(store) {
    console.log('[cron/sync-all] syncing store', store.id, store.shop_id);

    const errors = [];
    let orders = 0;
    let products = 0;
    let touched = false;

    // syncStoreOrders/syncStoreProducts each record their own start/complete
    // rows in sync_logs (including the 'started'-but-never-completed
    // signature of a hard timeout) and their own concurrency lock — no need
    // to duplicate that bookkeeping here.
    try {
      const orderResult = await syncStoreOrders(store, { deadline });
      orders = orderResult.orders.length;
      if (!orderResult.locked) touched = true;
    } catch (err) {
      console.error('[cron/sync-all] order sync failed for store', store.id, err);
      errors.push({ storeId: store.id, type: 'orders', error: err.message });
    }

    try {
      const productResult = await syncStoreProducts(store, { deadline });
      products = productResult.products.length;
      if (!productResult.locked) touched = true;
    } catch (err) {
      console.error('[cron/sync-all] product sync failed for store', store.id, err);
      errors.push({ storeId: store.id, type: 'products', error: err.message });
    }

    // Push notifications: runs after the orders sync above (so it reads the
    // freshly-upserted local order data, no extra Shopee calls) and BEFORE
    // auto-pack, so a brand-new READY_TO_SHIP order is notified while it's
    // still in a "new" status — auto-pack may flip it to PROCESSED this same
    // tick. Not opt-in per store: delivery is gated by whether the store's
    // owner has any push_subscriptions, and it's a cheap no-op when they don't.
    // Shares this store's deadline; never breaks the sync on failure.
    let notified = 0;
    if (Date.now() < deadline) {
      try {
        const notifyResult = await notifyStore(store, { deadline });
        notified = notifyResult.sent ?? 0;
      } catch (err) {
        console.error('[cron/sync-all] push notify failed for store', store.id, err);
        errors.push({ storeId: store.id, type: 'push', error: err.message });
      }
    }

    // Auto-pack, opt-in per store, runs last and shares this same deadline —
    // it never gets a fresh time window of its own. Orders sync above just
    // refreshed this store's local order_status, so auto-pack reads that
    // fresh data rather than calling Shopee's order list again.
    let packed = 0;
    if (store.auto_pack_enabled && Date.now() < deadline) {
      try {
        const packResult = await autoPackStore(store, { deadline });
        packed = packResult.packed;
      } catch (err) {
        console.error('[cron/sync-all] auto-pack failed for store', store.id, err);
        errors.push({ storeId: store.id, type: 'auto_pack', error: err.message });
      }
    }

    // Auto-boost, opt-in per store, runs last and shares this same deadline —
    // never a fresh window. Owns the store's 5 Shopee boost slots when enabled;
    // skips defensively if another booster is holding them (see autoBoostStore).
    let boosted = 0;
    if (store.auto_boost_enabled && Date.now() < deadline) {
      try {
        const boostResult = await autoBoostStore(store, { deadline });
        boosted = boostResult.boosted;
      } catch (err) {
        console.error('[cron/sync-all] auto-boost failed for store', store.id, err);
        errors.push({ storeId: store.id, type: 'auto_boost', error: err.message });
      }
    }

    return { storeId: store.id, touched, orders, products, packed, boosted, notified, errors };
  }

  const settled = await Promise.allSettled(stores.map(syncOneStore));

  let storesSynced = 0;
  let totalOrders = 0;
  let totalProducts = 0;
  let totalPacked = 0;
  let totalBoosted = 0;
  let totalNotified = 0;
  const errors = [];

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      // syncOneStore itself doesn't throw (both syncs are already wrapped in
      // their own try/catch) — this only fires on a genuinely unexpected
      // failure, so still surface it instead of silently dropping the store.
      console.error('[cron/sync-all] unexpected failure for store', stores[i].id, outcome.reason);
      errors.push({ storeId: stores[i].id, type: 'unexpected', error: String(outcome.reason) });
      continue;
    }

    const { touched, orders, products, packed, boosted, notified, errors: storeErrors } = outcome.value;
    totalOrders += orders;
    totalProducts += products;
    totalPacked += packed;
    totalBoosted += boosted;
    totalNotified += notified;
    errors.push(...storeErrors);
    if (touched) storesSynced += 1;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[cron/sync-all] done in ${elapsedMs}ms — stores: ${storesSynced}/${stores.length}, orders: ${totalOrders}, products: ${totalProducts}, auto-packed: ${totalPacked}, auto-boosted: ${totalBoosted}, notified: ${totalNotified}, errors: ${errors.length}`
  );

  return res.status(200).json({
    success: true,
    stores_synced: storesSynced,
    stores_total: stores.length,
    total_orders: totalOrders,
    total_products: totalProducts,
    total_packed: totalPacked,
    total_boosted: totalBoosted,
    total_notified: totalNotified,
    elapsed_ms: elapsedMs,
    errors,
  });
}
