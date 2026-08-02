import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { syncStoreProducts, SYNC_TIME_BUDGET_MS } from '../_lib/shopeeSync.js';
import { withCors } from '../_lib/cors.js';

// Cap the function runtime, same rationale as sync-orders.js.
export const config = { maxDuration: 60 };

export default withCors(handler);

async function handler(req, res) {
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
  // sync-orders.js, so N stores in one call still respect one 60s wall.
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
