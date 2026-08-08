import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { syncStoreOrders, syncStoreProducts } from '../_lib/shopeeSync.js';
import { autoPackStore } from '../_lib/autoPack.js';
import { autoBoostStore } from '../_lib/autoBoost.js';
import { syncStoreFlashSales } from '../_lib/flashSaleSync.js';
import { notifyStore } from '../_lib/pushNotify.js';
import { getValidTikTokToken } from '../_lib/tiktok.js';
import { withCors } from '../_lib/cors.js';

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

export default withCors(handler);

async function handler(req, res) {
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

  // TikTok Shop token refresh: proactively keep every connected shop's access
  // token fresh (getValidTikTokToken refreshes it when within 24h of expiry)
  // so it doesn't go stale purely for lack of user-triggered activity. This
  // runs before — and independently of — the Shopee sync below, since a
  // future TikTok data sync step would need this to have already happened.
  const tiktokErrors = [];
  const { data: tiktokShops, error: tiktokShopsError } = await supabaseAdmin
    .from('tiktok_shops')
    .select('shop_id');

  if (tiktokShopsError) {
    console.error('[cron/sync-all] failed to load tiktok_shops', tiktokShopsError);
    tiktokErrors.push({ storeId: null, type: 'tiktok_token_refresh', error: tiktokShopsError.message });
  } else if (tiktokShops && tiktokShops.length > 0) {
    console.log('[cron/sync-all] checking token freshness for', tiktokShops.length, 'TikTok shop(s)');
    const tiktokResults = await Promise.allSettled(
      tiktokShops.map((shop) => getValidTikTokToken(shop.shop_id))
    );
    tiktokResults.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        console.error('[cron/sync-all] tiktok token refresh failed for shop', tiktokShops[i].shop_id, outcome.reason);
        tiktokErrors.push({
          storeId: tiktokShops[i].shop_id,
          type: 'tiktok_token_refresh',
          error: String(outcome.reason?.message ?? outcome.reason),
        });
      }
    });
  }

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
      errors: tiktokErrors,
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

    // Flash Deals, READ-ONLY. Not opt-in per store — it only ever reads, so
    // there is nothing to collide with (BigSeller owns slot creation and keeps
    // it). Runs last and shares this same deadline, never a fresh window, so on
    // a tight tick it defers sessions rather than pushing the cron past 60s.
    let flashSessions = 0;
    if (Date.now() < deadline) {
      try {
        const flashResult = await syncStoreFlashSales(store, { deadline });
        flashSessions = flashResult.sessions ?? 0;
      } catch (err) {
        console.error('[cron/sync-all] flash sale sync failed for store', store.id, err);
        errors.push({ storeId: store.id, type: 'flash_sales', error: err.message });
      }
    }

    return { storeId: store.id, touched, orders, products, packed, boosted, notified, flashSessions, errors };
  }

  const settled = await Promise.allSettled(stores.map(syncOneStore));

  let storesSynced = 0;
  let totalOrders = 0;
  let totalProducts = 0;
  let totalPacked = 0;
  let totalBoosted = 0;
  let totalNotified = 0;
  let totalFlashSessions = 0;
  const errors = [...tiktokErrors];

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

    const { touched, orders, products, packed, boosted, notified, flashSessions, errors: storeErrors } = outcome.value;
    totalOrders += orders;
    totalProducts += products;
    totalPacked += packed;
    totalBoosted += boosted;
    totalNotified += notified;
    totalFlashSessions += flashSessions;
    errors.push(...storeErrors);
    if (touched) storesSynced += 1;
  }

  // Store-level failures recorded in sync_logs but NOT thrown — e.g. a
  // flash-sale session whose item fetch failed, which syncStoreFlashSales
  // catches, logs as status 'error', and returns from normally. Without this
  // the summary could report errors: 0 while sync_logs held a failure, which is
  // the same class of blind spot as a 'started' row with no completion.
  //
  // Read from sync_logs rather than from return values so this covers EVERY
  // sync type uniformly — orders, products, auto-pack, auto-boost, flash sales,
  // and anything added later — with no per-feature wiring.
  try {
    // 5s of slack absorbs clock skew between this process and Postgres, so a
    // row written moments after startedAt can't fall outside the window.
    const since = new Date(startedAt - 5_000).toISOString();
    const { data: loggedErrors, error: logQueryError } = await supabaseAdmin
      .from('sync_logs')
      .select('store_id, sync_type, message')
      .eq('status', 'error')
      .gte('synced_at', since)
      .limit(200);

    if (logQueryError) {
      console.error('[cron/sync-all] failed to read sync_logs for error reconciliation', logQueryError);
    } else {
      // Don't double-report a failure that already threw and was collected above.
      const seen = new Set(errors.map((e) => `${e.storeId}:${e.type}`));
      for (const row of loggedErrors ?? []) {
        const key = `${row.store_id}:${row.sync_type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({
          storeId: row.store_id,
          type: row.sync_type,
          error: row.message ?? 'failed (no message recorded)',
          source: 'sync_logs',
        });
      }
    }
  } catch (err) {
    // Reconciliation is diagnostics — it must never turn a successful cron run
    // into a failed HTTP response.
    console.error('[cron/sync-all] error reconciliation threw', err);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[cron/sync-all] done in ${elapsedMs}ms — stores: ${storesSynced}/${stores.length}, orders: ${totalOrders}, products: ${totalProducts}, auto-packed: ${totalPacked}, auto-boosted: ${totalBoosted}, notified: ${totalNotified}, flash sessions: ${totalFlashSessions}, errors: ${errors.length}`
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
    total_flash_sessions: totalFlashSessions,
    elapsed_ms: elapsedMs,
    errors,
  });
}
