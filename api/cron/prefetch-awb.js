import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { prefetchStoreAwbs } from '../_lib/awbPrefetch.js';
import { withCors } from '../_lib/cors.js';

// Cap the runtime. Vercel Hobby allows up to 60s.
export const config = { maxDuration: 60 };

// Split out of cron/sync-all.js because it never actually ran there: order
// sync alone takes 5-15s per store, and by the time products, push,
// auto-boost and flash sales had finished there was never enough left to
// clear prefetch's remaining-time gate. It cached 3 labels and stalled.
// Owning its own invocation means the budget below is the whole window.
//
// Same shape as sync-all's budget for the same reason: stores run
// CONCURRENTLY (Promise.allSettled), so wall-clock time is bounded by the
// slowest single store rather than the sum of all of them, and this only has
// to cover one store's work plus margin for the response. The 10s of
// headroom under Hobby's 60s ceiling is what keeps a run from being killed
// mid-flight — a hard kill would strand 'started' sync_logs rows and leave
// documents created at Shopee that were never downloaded.
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
    console.error('[cron/prefetch-awb] CRON_SECRET is not configured');
    return res.status(500).json({ success: false, error: 'CRON_SECRET not configured' });
  }

  if (!auth.ok) {
    console.warn('[cron/prefetch-awb] unauthorized cron request');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;

  // Service-role client: every active Shopee store across ALL users. Prefetch
  // is not opt-in per store — it only touches orders already PROCESSED with a
  // tracking number, and caches a label the seller is going to print anyway.
  const { data: stores, error: storesError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'shopee')
    .eq('is_active', true);

  if (storesError) {
    console.error('[cron/prefetch-awb] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    console.log('[cron/prefetch-awb] no active Shopee stores');
    return res.status(200).json({ success: true, stores_total: 0, total_cached: 0, errors: [] });
  }

  console.log(`[cron/prefetch-awb] prefetching for ${stores.length} active Shopee store(s) in parallel`);

  // allSettled (not all) so one store's rejection can't cancel the others'
  // in-flight work or their sync_logs bookkeeping. prefetchStoreAwbs already
  // handles its own per-group failures internally; this only catches a
  // genuinely unexpected throw.
  const settled = await Promise.allSettled(
    stores.map((store) => prefetchStoreAwbs(store, { deadline }))
  );

  let totalCached = 0;
  let totalAttempted = 0;
  let deferredStores = 0;
  let lockedStores = 0;
  const errors = [];

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      console.error('[cron/prefetch-awb] unexpected failure for store', stores[i].id, outcome.reason);
      errors.push({
        storeId: stores[i].id,
        type: 'awb_prefetch',
        error: String(outcome.reason?.message ?? outcome.reason),
      });
      continue;
    }

    const result = outcome.value;
    totalCached += result.cached ?? 0;
    totalAttempted += result.attempted ?? 0;
    if (result.deferred) deferredStores += 1;
    if (result.locked) lockedStores += 1;
    // prefetchStoreAwbs returns (rather than throws) on a candidate-query
    // failure, so surface that here instead of silently counting a zero.
    if (result.error) {
      errors.push({ storeId: stores[i].id, type: 'awb_prefetch', error: result.error });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[cron/prefetch-awb] done in ${elapsedMs}ms — stores: ${stores.length}, cached: ${totalCached}/${totalAttempted} attempted, deferred: ${deferredStores}, locked: ${lockedStores}, errors: ${errors.length}`
  );

  return res.status(200).json({
    success: true,
    stores_total: stores.length,
    total_cached: totalCached,
    total_attempted: totalAttempted,
    deferred_stores: deferredStores,
    locked_stores: lockedStores,
    elapsed_ms: elapsedMs,
    errors,
  });
}
