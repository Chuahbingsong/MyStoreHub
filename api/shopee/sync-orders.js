import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { syncStoreOrders, SYNC_TIME_BUDGET_MS } from '../_lib/shopeeSync.js';

// Cap the function runtime. Vercel Hobby allows up to 60s; the platform default
// (300s) still times out on large stores. syncStoreOrders' own SYNC_TIME_BUDGET_MS
// stops it from starting new work well before this wall.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
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
