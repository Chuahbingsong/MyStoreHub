import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from '../_lib/shopeeSync.js';
import {
  copyFlashSale,
  COPY_ENABLED,
  COPY_WINDOW_MS,
  COPY_MAX_PER_WINDOW,
} from '../_lib/flashSaleCopy.js';
import { withCors } from '../_lib/cors.js';

// Copies one flash sale session into a free upcoming slot. This is the ONLY
// endpoint in the app that writes to Shopee.
//
// COPY_ENABLED is checked first, before any store or session is loaded. See
// api/_lib/flashSaleCopy.js for the gate's history.
//
// Throttling mirrors sync-flash-sale.js, tightened because this writes:
//   1. per-store rolling window, COPY_MAX_PER_WINDOW per COPY_WINDOW_MS,
//      counted from this endpoint's own sync_logs rows. Fails CLOSED.
//   2. acquireSyncLock on store+'flash_sale_copy'.
// There is no per-session cooldown — each copy targets a different slot — but
// copyFlashSale itself refuses a slot that already holds a session for the
// store, which is the check that actually matters here.
export const config = { maxDuration: 30 };

const SYNC_TYPE = 'flash_sale_copy';

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
    console.error('[copy-flash-sale] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // The gate, before anything can reach Shopee.
  if (!COPY_ENABLED) {
    return res.status(503).json({
      success: false,
      error: 'Copy is not enabled yet.',
      disabled: true,
    });
  }

  const { source_row_id, timeslot_id } = req.body ?? {};
  if (!source_row_id || !timeslot_id) {
    return res
      .status(400)
      .json({ success: false, error: 'source_row_id and timeslot_id are required' });
  }

  const { data: source, error: sourceError } = await supabaseAdmin
    .from('flash_sales')
    .select('id, store_id, flash_sale_id')
    .eq('id', source_row_id)
    .maybeSingle();
  if (sourceError) {
    console.error('[copy-flash-sale] failed to load source', sourceError);
    return res.status(500).json({ success: false, error: 'Failed to load source session' });
  }
  if (!source) return res.status(404).json({ success: false, error: 'Source session not found' });

  const { data: store, error: storeError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('id', source.store_id)
    .eq('platform', 'shopee')
    .maybeSingle();
  if (storeError) {
    console.error('[copy-flash-sale] failed to load store', storeError);
    return res.status(500).json({ success: false, error: 'Failed to load store' });
  }
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (store.user_id !== user.id) return res.status(403).json({ success: false, error: 'Forbidden' });

  // ---- rolling window ----
  const windowStart = new Date(Date.now() - COPY_WINDOW_MS).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from('sync_logs')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', store.id)
    .eq('sync_type', SYNC_TYPE)
    .gte('synced_at', windowStart);

  // `reason` distinguishes the refusals a caller must handle DIFFERENTLY. A
  // batching client (the multi-slot copy in src/pages/FlashDeals.jsx) cannot
  // tell them apart from the message or from retryAfterMs alone, and the
  // required wait is an order of magnitude apart:
  //   rate_limited — the rolling window; clears in at most COPY_WINDOW_MS.
  //   locked       — a copy is in flight, OR a previous one was hard-killed by
  //                  the platform and left a 'started' row holding the lock for
  //                  the full LOCK_TTL_MS (90s). retryAfterMs is a poll
  //                  interval here, NOT a time-to-clear.
  // Neither refusal writes a sync_logs row, so neither consumes rate budget.
  if (countError) {
    console.error('[copy-flash-sale] failed to read rate window, refusing', countError);
    return res.status(503).json({
      success: false,
      reason: 'rate_limiter_unavailable',
      error: 'Rate limiter unavailable, try again shortly.',
      retryAfterMs: COPY_WINDOW_MS,
    });
  }
  if ((count ?? 0) >= COPY_MAX_PER_WINDOW) {
    return res.status(429).json({
      success: false,
      reason: 'rate_limited',
      error: `Too many copies for this store. Limit is ${COPY_MAX_PER_WINDOW} per minute.`,
      retryAfterMs: COPY_WINDOW_MS,
    });
  }

  // ---- in-flight lock ----
  const canProceed = await acquireSyncLock(store.id, SYNC_TYPE);
  if (!canProceed) {
    return res.status(429).json({
      success: false,
      reason: 'locked',
      error: 'A copy is already running for this store.',
      retryAfterMs: 5_000,
    });
  }

  const logId = await logSyncStart(store.id, SYNC_TYPE);

  try {
    const result = await copyFlashSale(
      store,
      { sourceRowId: source_row_id, timeslotId: timeslot_id },
      { deadline: Date.now() + 25_000 }
    );

    // 'partial' and 'unverified' are logged as errors, not successes — a copy
    // that didn't fully land must stay visible in sync_logs.
    const logStatus = result.status === 'success' ? 'success' : 'error';
    const detail =
      result.status === 'success'
        ? `fs=${result.flashSaleId} on slot ${result.timeslotId}: ${result.persistedCount}/${result.sentCount} models`
        : `fs=${result.flashSaleId} on slot ${result.timeslotId}: ${result.status.toUpperCase()} — ` +
          `${result.persistedCount ?? '?'}/${result.sentCount} models` +
          (result.missing?.length ? `; missing ${result.missing.map((m) => m.key).join(', ')}` : '') +
          (result.priceMismatches?.length ? `; price drift on ${result.priceMismatches.length}` : '') +
          (result.rejected?.length ? `; rejected ${result.rejected.length}` : '') +
          (result.addError ? `; add error: ${result.addError}` : '') +
          (result.readBackError ? `; read-back error: ${result.readBackError}` : '');

    await logSyncComplete(logId, logStatus, detail);

    // HTTP 200 even for partial: the request was handled and the diff is the
    // payload. The caller branches on result.status, which is never inferred
    // from the write call.
    return res.status(200).json({ success: result.status === 'success', ...result });
  } catch (err) {
    console.error('[copy-flash-sale] failed', err);
    await logSyncComplete(logId, 'error', err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
}
