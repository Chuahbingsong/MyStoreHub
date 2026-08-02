import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from '../_lib/shopeeSync.js';
import {
  syncOneFlashSale,
  SESSION_SYNC_COOLDOWN_MS,
  STORE_SYNC_WINDOW_MS,
  STORE_SYNC_MAX_PER_WINDOW,
} from '../_lib/flashSaleSync.js';
import { withCors } from '../_lib/cors.js';

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
export const config = { maxDuration: 30 };

const SYNC_TYPE = 'flash_sale_one';

export default withCors(handler);

async function handler(req, res) {
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
    .eq('sync_type', SYNC_TYPE)
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
  const canProceed = await acquireSyncLock(store.id, SYNC_TYPE);
  if (!canProceed) {
    return res.status(429).json({
      success: false,
      error: 'A refresh is already running for this store.',
      retryAfterMs: 5_000,
    });
  }

  // Written before the work starts, so it counts toward layer 2 even if the
  // call then times out — a burst of timeouts must still consume the budget.
  const logId = await logSyncStart(store.id, SYNC_TYPE);

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
