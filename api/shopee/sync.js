import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { syncStoreOrders, syncStoreProducts, SYNC_TIME_BUDGET_MS, acquireSyncLock, logSyncStart, logSyncComplete } from '../_lib/shopeeSync.js';
import {
  syncOneFlashSale,
  SESSION_SYNC_COOLDOWN_MS,
  STORE_SYNC_WINDOW_MS,
  STORE_SYNC_MAX_PER_WINDOW,
} from '../_lib/flashSaleSync.js';
import { withCors } from '../_lib/cors.js';

// Combines what used to be api/shopee/sync-orders.js, sync-products.js and
// sync-flash-sale.js into one Vercel function (dispatched on ?type=) to stay
// under the Hobby plan's 12-function cap. Routing only — every handler body
// and the _lib modules it calls are unchanged from the originals.
export const config = { maxDuration: 60 };

const FLASH_SALE_SYNC_TYPE = 'flash_sale_one';

export default withCors(handler);

function handler(req, res) {
  const { type } = req.query;

  if (type === 'orders') return handleSyncOrders(req, res);
  if (type === 'products') return handleSyncProducts(req, res);
  if (type === 'flash-sale') return handleSyncFlashSale(req, res);

  return res.status(400).json({ success: false, error: 'Unknown or missing type. Use ?type=orders|products|flash-sale' });
}

async function handleSyncOrders(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error('[sync-orders] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, days: daysRaw } = req.body ?? {};

  // Optional override of the fetch window (in days). Falls back to the default
  // in syncStoreOrders when not a positive number.
  const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0 ? Number(daysRaw) : undefined;

  if (store_id) {
    const { data: requestedStore, error: storeLookupError } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .eq('platform', 'shopee')
      .maybeSingle();

    if (storeLookupError) {
      console.error('[sync-orders] failed to load store', storeLookupError);
      return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
    }

    if (!requestedStore) {
      return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
    }

    if (requestedStore.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
  }

  let storesQuery = supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'shopee')
    .eq('user_id', user.id);

  if (store_id) {
    storesQuery = storesQuery.eq('id', store_id);
  } else {
    storesQuery = storesQuery.eq('is_active', true);
  }

  const { data: stores, error: storesError } = await storesQuery;

  if (storesError) {
    console.error('[sync-orders] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
  }

  const results = [];
  const errors = [];
  // Shared across every store synced in this request — not a fresh budget
  // per store — so N stores in one call still respect the same 60s wall.
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  for (const store of stores) {
    try {
      console.log('[sync-orders] syncing store', store.id, store.shop_id);
      const result = await syncStoreOrders(store, { days, deadline });
      results.push(result);
    } catch (err) {
      // syncStoreOrders already records this in sync_logs itself (a
      // started-but-uncompleted row if it was killed by a hard timeout, or an
      // explicit 'error' row otherwise) — this catch only needs to keep the
      // per-store loop going and surface the failure in the HTTP response.
      console.error('[sync-orders] sync failed for store', store.id, err);
      errors.push({ storeId: store.id, error: err.message });
    }
  }

  const allOrders = results.flatMap((r) => r.orders);
  // If any store still has orders beyond this sync's time budget, signal
  // that a follow-up sync is needed to fetch the rest.
  const hasMore = results.some((r) => r.hasMore);

  if (errors.length > 0 && results.length === 0) {
    return res.status(502).json({ success: false, errors });
  }

  return res.status(200).json({
    success: true,
    synced: allOrders.length,
    hasMore,
    orders: allOrders,
    errors: errors.length > 0 ? errors : undefined,
  });
}

async function handleSyncProducts(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error('[sync-products] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id } = req.body ?? {};

  if (store_id) {
    const { data: requestedStore, error: storeLookupError } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .eq('platform', 'shopee')
      .maybeSingle();

    if (storeLookupError) {
      console.error('[sync-products] failed to load store', storeLookupError);
      return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
    }

    if (!requestedStore) {
      return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
    }

    if (requestedStore.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
  }

  let storesQuery = supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'shopee')
    .eq('user_id', user.id);

  if (store_id) {
    storesQuery = storesQuery.eq('id', store_id);
  } else {
    storesQuery = storesQuery.eq('is_active', true);
  }

  const { data: stores, error: storesError } = await storesQuery;

  if (storesError) {
    console.error('[sync-products] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
  }

  const results = [];
  const errors = [];
  // Shared across every store synced in this request, same convention as
  // sync-orders, so N stores in one call still respect one 60s wall.
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  for (const store of stores) {
    try {
      console.log('[sync-products] syncing store', store.id, store.shop_id);
      const result = await syncStoreProducts(store, { deadline });
      results.push(result);
    } catch (err) {
      // syncStoreProducts already records this in sync_logs itself (a
      // started-but-uncompleted row if killed by a hard timeout, or an
      // explicit 'error' row otherwise) — no need to also log here.
      console.error('[sync-products] sync failed for store', store.id, err);
      errors.push({ storeId: store.id, error: err.message });
    }
  }

  const allProducts = results.flatMap((r) => r.products);

  if (errors.length > 0 && results.length === 0) {
    return res.status(502).json({ success: false, errors });
  }

  return res.status(200).json({
    success: true,
    synced: allProducts.length,
    products: allProducts,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// On-demand refresh of ONE flash sale session. Still read-only against Shopee —
// this endpoint pulls fresh data, it never creates or edits a sale.
//
// THROTTLING, three independent layers, all server-side. The disabled button in
// the UI is a courtesy; this endpoint is reachable directly, so it has to hold
// the line by itself:
//
//   1. Per-session cooldown (SESSION_SYNC_COOLDOWN_MS) measured against the
//      stored observed_at. Hammering one session's button is a no-op after the
//      first press.
//   2. Per-store rolling window (STORE_SYNC_MAX_PER_WINDOW per
//      STORE_SYNC_WINDOW_MS), counted from the sync_logs rows this endpoint
//      writes. Layer 1 alone doesn't stop someone walking 44 different sessions
//      back to back, which would be ~130 Shopee calls in a minute.
//   3. acquireSyncLock on store+'flash_sale_one', so two in-flight requests for
//      the same store can't interleave.
//
// Both 429 paths return retryAfterMs so the client can show a real countdown
// instead of guessing.
async function handleSyncFlashSale(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    console.error('[sync-flash-sale] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { flash_sale_row_id } = req.body ?? {};
  if (!flash_sale_row_id) {
    return res.status(400).json({ success: false, error: 'flash_sale_row_id is required' });
  }

  // Load the session and its store together, then verify ownership. Addressing
  // by our own row id (not Shopee's flash_sale_id) means the caller can't point
  // this at a session belonging to a store they don't own.
  const { data: sale, error: saleError } = await supabaseAdmin
    .from('flash_sales')
    .select('id, store_id, flash_sale_id, observed_at')
    .eq('id', flash_sale_row_id)
    .maybeSingle();

  if (saleError) {
    console.error('[sync-flash-sale] failed to load flash sale', saleError);
    return res.status(500).json({ success: false, error: 'Failed to load flash sale' });
  }
  if (!sale) return res.status(404).json({ success: false, error: 'Flash sale not found' });

  const { data: store, error: storeError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('id', sale.store_id)
    .eq('platform', 'shopee')
    .maybeSingle();

  if (storeError) {
    console.error('[sync-flash-sale] failed to load store', storeError);
    return res.status(500).json({ success: false, error: 'Failed to load store' });
  }
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (store.user_id !== user.id) return res.status(403).json({ success: false, error: 'Forbidden' });

  // ---- layer 1: per-session cooldown ----
  const lastObserved = sale.observed_at ? new Date(sale.observed_at).getTime() : 0;
  const sinceLast = Date.now() - lastObserved;
  if (sinceLast < SESSION_SYNC_COOLDOWN_MS) {
    return res.status(429).json({
      success: false,
      error: 'This session was just refreshed.',
      retryAfterMs: SESSION_SYNC_COOLDOWN_MS - sinceLast,
      observedAt: sale.observed_at,
    });
  }

  // ---- layer 2: per-store rolling window ----
  const windowStart = new Date(Date.now() - STORE_SYNC_WINDOW_MS).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from('sync_logs')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', store.id)
    .eq('sync_type', FLASH_SALE_SYNC_TYPE)
    .gte('synced_at', windowStart);

  if (countError) {
    // Fail CLOSED here, unlike acquireSyncLock's fail-open: the whole point of
    // this layer is protecting a rate limit we've already tripped in the wild,
    // so an unreadable counter is not a reason to let the call through.
    console.error('[sync-flash-sale] failed to read rate window, refusing', countError);
    return res.status(503).json({
      success: false,
      error: 'Rate limiter unavailable, try again shortly.',
      retryAfterMs: STORE_SYNC_WINDOW_MS,
    });
  }

  if ((count ?? 0) >= STORE_SYNC_MAX_PER_WINDOW) {
    return res.status(429).json({
      success: false,
      error: `Too many refreshes for this store. Limit is ${STORE_SYNC_MAX_PER_WINDOW} per minute.`,
      retryAfterMs: STORE_SYNC_WINDOW_MS,
    });
  }

  // ---- layer 3: in-flight lock ----
  const canProceed = await acquireSyncLock(store.id, FLASH_SALE_SYNC_TYPE);
  if (!canProceed) {
    return res.status(429).json({
      success: false,
      error: 'A refresh is already running for this store.',
      retryAfterMs: 5_000,
    });
  }

  // Written before the work starts, so it counts toward layer 2 even if the
  // call then times out — a burst of timeouts must still consume the budget.
  const logId = await logSyncStart(store.id, FLASH_SALE_SYNC_TYPE);

  try {
    const result = await syncOneFlashSale(store, sale.flash_sale_id, {
      deadline: Date.now() + 25_000,
    });
    await logSyncComplete(
      logId,
      'success',
      `fs=${result.flashSaleId}: ${result.models} model row(s), ${result.enabledItemCount} enabled item(s)`
    );
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[sync-flash-sale] failed', sale.flash_sale_id, err);
    await logSyncComplete(logId, 'error', err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
}
