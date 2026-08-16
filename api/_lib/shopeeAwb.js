import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const MAX_STATUS_RETRIES = 5;
const STATUS_RETRY_DELAY_MS = 2000;

// Used when Shopee doesn't tell us which document type an order supports.
const DEFAULT_SHIPPING_DOCUMENT_TYPE = 'NORMAL_AIR_WAYBILL';

// Tried first, without asking get_shipping_document_parameter what the order
// supports. Every logged call has come back with this as both the suggested
// AND the only selectable type, while costing 828–2080ms — so the lookup is
// now paid for only when this assumption actually turns out to be wrong.
// If the fallback below ever fires for a real courier, its logged raw Shopee
// error is the evidence for revisiting this.
const OPTIMISTIC_SHIPPING_DOCUMENT_TYPE = 'THERMAL_AIR_WAYBILL';

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Perf instrumentation (temporary — remove once we've measured real timings).
// Marks are kept per-request (not module-level) so concurrent invocations on a
// warm lambda can't interleave each other's timings. ---
function makePerfTracker() {
  const marks = [];
  return {
    start(label) {
      const t = Date.now();
      return () => {
        const ms = Date.now() - t;
        marks.push({ label, ms });
        console.log(`[print-awb][perf] ${label}: ${ms}ms`);
        return ms;
      };
    },
    summary() {
      const total = marks.reduce((sum, m) => sum + m.ms, 0);
      console.log('[print-awb][perf] ===== SUMMARY =====');
      for (const m of marks) {
        console.log(`[print-awb][perf]   ${m.label}: ${m.ms}ms (${((m.ms / total) * 100).toFixed(1)}%)`);
      }
      console.log(`[print-awb][perf]   TOTAL: ${total}ms`);
    },
  };
}
// --- end perf instrumentation ---

/**
 * Carries the step name and Shopee's complete response body up to the handler,
 * so the client gets the real reason instead of a generic message.
 */
class ShopeeStepError extends Error {
  constructor(step, message, shopeeResponse) {
    super(message);
    this.name = 'ShopeeStepError';
    this.step = step;
    this.shopeeResponse = shopeeResponse ?? null;
  }
}

/**
 * Every JSON call to Shopee goes through here so the complete raw body is
 * always logged, whether the call succeeded or not.
 */
async function shopeeJsonCall(step, url, init) {
  let response;
  let bodyText;

  try {
    response = await fetch(url, init);
    bodyText = await response.text();
  } catch (err) {
    console.error(`[print-awb] ${step}: network error`, err.message);
    throw new ShopeeStepError(step, `Network error calling Shopee (${step}): ${err.message}`, null);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // Shopee occasionally returns HTML (gateway errors); keep it verbatim.
    data = { _unparsed_body: bodyText };
  }

  console.log(`[print-awb] ${step}: HTTP ${response.status} raw response:`);
  console.log(JSON.stringify(data, null, 2));

  if (!response.ok || data.error) {
    // Shopee's top-level message is often just "All failed, please check
    // result_list for detail" — fold the per-order reasons into the message so
    // the caller never has to dig for them.
    const detail = describeFailures(collectFailures(data));
    const base = data.message || `Shopee call failed: ${step}`;
    throw new ShopeeStepError(step, detail ? `${base} — ${detail}` : base, data);
  }

  return data;
}

/**
 * Pulls per-order failures out of a Shopee result_list. This is where the real
 * reason lives when the top-level message is just "All failed, please check
 * result_list for detail".
 */
function collectFailures(data) {
  const resultList = data?.response?.result_list ?? [];
  return resultList
    .filter((entry) => entry.fail_error || entry.fail_message)
    .map((entry) => ({
      order_sn: entry.order_sn,
      fail_error: entry.fail_error ?? null,
      fail_message: entry.fail_message ?? null,
    }));
}

function describeFailures(failures) {
  return failures
    .map((f) => `${f.order_sn}: ${f.fail_message || f.fail_error}`)
    .join('; ');
}

async function refreshShopeeToken(store) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp);

  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  console.log('[print-awb] refreshing token for store', store.id);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: store.refresh_token,
      shop_id: Number(store.shop_id),
      partner_id: Number(SHOPEE_PARTNER_ID),
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[print-awb] token refresh failed', data);
    throw new Error(data.message || 'Failed to refresh Shopee access token');
  }

  const tokenExpiresAt = new Date(Date.now() + data.expire_in * 1000).toISOString();

  const { error: updateError } = await supabaseAdmin
    .from('stores')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: tokenExpiresAt,
    })
    .eq('id', store.id);

  if (updateError) {
    console.error('[print-awb] failed to save refreshed token', updateError);
    throw new Error('Failed to save refreshed Shopee token');
  }

  console.log('[print-awb] token refreshed for store', store.id);

  return {
    ...store,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: tokenExpiresAt,
  };
}

async function ensureFreshToken(store) {
  const expiresAt = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
  if (expiresAt <= Date.now()) {
    return refreshShopeeToken(store);
  }
  return store;
}

/**
 * Builds a signed Shopee shop-API URL with the common auth params in the query
 * string. Body (for POST calls) is sent separately as JSON.
 */
function buildSignedUrl(path, store, extraParams = {}) {
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: store.shop_id,
    sign,
    ...extraParams,
  });

  return `${SHOPEE_API_BASE}${path}?${params.toString()}`;
}

async function getTrackingNumber(store, orderSn) {
  const path = '/api/v2/logistics/get_tracking_number';
  const url = buildSignedUrl(path, store, { order_sn: orderSn });

  console.log('[print-awb] getting tracking number for', orderSn);

  const data = await shopeeJsonCall('get_tracking_number', url);

  // Shopee returns an empty string (not an error) when the order has no label
  // assigned yet, so treat blank as "not ready".
  const trackingNumber = data.response?.tracking_number || null;
  console.log(`[print-awb] extracted tracking_number for ${orderSn}: ${trackingNumber || '(none)'}`);
  return trackingNumber;
}

const NO_TRACKING_REASON = 'Order not ready for shipping label yet (no tracking number)';

// Caps how many get_tracking_number calls run at once so a large bulk print
// doesn't fan out one Shopee request per order simultaneously.
const TRACKING_NUMBER_CONCURRENCY = 5;

/**
 * Runs fn over items with at most `limit` in flight at once.
 */
async function mapWithConcurrency(items, limit, fn) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

/**
 * One read of local order state, serving every local decision this request
 * makes:
 *   - trackingByOrderSn: tracking numbers already on file, so a reprint
 *     doesn't re-ask Shopee for a value we stored last time.
 *   - allPrinted: whether EVERY requested order has been printed before,
 *     which is the reprint fast path's eligibility gate.
 *   - ordersByOrderSn: the raw rows, carrying the awb_cache_* columns and the
 *     fields the cache fingerprint is computed from.
 * Deliberately one query rather than three — each extra check would otherwise
 * add a round trip to first-time prints, which benefit from none of them.
 * On error, degrades to "nothing cached, not eligible": the full pipeline
 * then runs exactly as it did before any of this existed.
 */
async function loadOrderPrintState(storeId, orderSnList) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select(
      'platform_order_id, tracking_number, awb_printed, order_status, courier_name, shipping_address, awb_cached_path, awb_cache_fingerprint, awb_cached_at'
    )
    .eq('store_id', storeId)
    .in('platform_order_id', orderSnList);

  if (error) {
    console.error('[print-awb] failed to load local order state, will fetch all from Shopee', error);
    return { trackingByOrderSn: {}, allPrinted: false, ordersByOrderSn: {} };
  }

  const trackingByOrderSn = {};
  const ordersByOrderSn = {};
  const printed = new Set();
  for (const row of data ?? []) {
    if (row.tracking_number) trackingByOrderSn[row.platform_order_id] = row.tracking_number;
    if (row.awb_printed) printed.add(row.platform_order_id);
    ordersByOrderSn[row.platform_order_id] = row;
  }

  return {
    trackingByOrderSn,
    // An order missing from the result set is, correctly, not printed.
    allPrinted: orderSnList.every((orderSn) => printed.has(orderSn)),
    ordersByOrderSn,
  };
}

/**
 * Resolves a tracking number for each order. Orders without one can't have a
 * label created, so they're reported as skipped rather than poisoning the
 * whole batch. Orders that already have a tracking_number stored from a
 * previous print reuse it instead of re-calling Shopee; only the remainder
 * are fetched, with up to TRACKING_NUMBER_CONCURRENCY in flight at once.
 * Returns freshlyFetchedOrderSns separately so the caller only writes back
 * to the orders table what actually changed.
 */
async function resolveTrackingNumbers(store, storedByOrderSn, orderSnList, perf) {
  const cachedOrderSns = orderSnList.filter((orderSn) => storedByOrderSn[orderSn]);
  const toFetch = orderSnList.filter((orderSn) => !storedByOrderSn[orderSn]);

  console.log(
    `[print-awb] tracking numbers: ${cachedOrderSns.length} reused from orders table, ${toFetch.length} to fetch from Shopee (concurrency ${TRACKING_NUMBER_CONCURRENCY})`
  );

  const trackingByOrderSn = {};
  for (const orderSn of cachedOrderSns) {
    trackingByOrderSn[orderSn] = storedByOrderSn[orderSn];
  }

  const skipped = [];
  const freshlyFetchedOrderSns = [];

  // Per-order marks below overlap in wall-clock time (they run concurrently),
  // so their sum will exceed this step's actual elapsed time — expected, not
  // a bug in the numbers.
  await mapWithConcurrency(toFetch, TRACKING_NUMBER_CONCURRENCY, async (orderSn) => {
    const done = perf.start(`get_tracking_number[${orderSn}]`);
    const trackingNumber = await getTrackingNumber(store, orderSn);
    done();
    if (trackingNumber) {
      trackingByOrderSn[orderSn] = trackingNumber;
      freshlyFetchedOrderSns.push(orderSn);
    } else {
      console.error(`[print-awb] ${orderSn}: ${NO_TRACKING_REASON} — skipping`);
      skipped.push({ order_sn: orderSn, reason: NO_TRACKING_REASON });
    }
  });

  console.log('[print-awb] tracking numbers resolved:');
  console.log(JSON.stringify({ tracking: trackingByOrderSn, skipped }, null, 2));

  return { trackingByOrderSn, skipped, freshlyFetchedOrderSns };
}

/**
 * Persists each resolved tracking number onto its order row so it's available
 * for lookups elsewhere (e.g. scan-to-check) without re-calling Shopee. This
 * writes as soon as Shopee assigns a tracking number, regardless of whether
 * the label PDF itself later succeeds or fails to print — the tracking
 * number is already real at that point. Never throws: this is bookkeeping,
 * not the print itself.
 */
async function persistTrackingNumbers(storeId, trackingByOrderSn) {
  const entries = Object.entries(trackingByOrderSn);
  if (entries.length === 0) return;

  const results = await Promise.all(
    entries.map(([orderSn, trackingNumber]) =>
      supabaseAdmin
        .from('orders')
        .update({ tracking_number: trackingNumber })
        .eq('store_id', storeId)
        .eq('platform_order_id', orderSn)
    )
  );

  const failures = results.filter((r) => r.error);
  if (failures.length > 0) {
    console.error('[print-awb] failed to persist some tracking numbers', failures.map((f) => f.error));
  }
}

/**
 * Asks Shopee which document type each order actually supports. Different
 * couriers allow different types, so the suggested value is safer than
 * hardcoding one. Never throws: this is advisory, and its per-order
 * fail_error/fail_message are logged because they usually explain why a
 * later create_shipping_document call fails.
 */
async function getShippingDocumentTypes(store, orderSnList) {
  const path = '/api/v2/logistics/get_shipping_document_parameter';
  const url = buildSignedUrl(path, store);
  const body = { order_list: orderSnList.map((order_sn) => ({ order_sn })) };

  const typeByOrderSn = {};

  try {
    const data = await shopeeJsonCall('get_shipping_document_parameter', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const failures = collectFailures(data);
    if (failures.length > 0) {
      console.error('[print-awb] get_shipping_document_parameter per-order failures:');
      console.error(JSON.stringify(failures, null, 2));
    }

    (data.response?.result_list ?? []).forEach((entry) => {
      const suggested = entry.suggest_shipping_document_type;
      const selectable = entry.selectable_shipping_document_type ?? [];
      console.log(
        `[print-awb] ${entry.order_sn}: suggested=${suggested || '(none)'} selectable=${
          selectable.join(',') || '(none)'
        }`
      );
      if (suggested) typeByOrderSn[entry.order_sn] = suggested;
    });
  } catch (err) {
    // Fall through to the default type; create_shipping_document will surface
    // the real error with full detail if the order genuinely can't be printed.
    console.error('[print-awb] get_shipping_document_parameter failed, using default type:', err.message);
  }

  return typeByOrderSn;
}

async function createShippingDocument(store, orderSnList, typeByOrderSn = {}, trackingByOrderSn = {}) {
  const path = '/api/v2/logistics/create_shipping_document';
  const url = buildSignedUrl(path, store);

  // tracking_number is what Shopee validates here — omitting it produces
  // "The tracking number is invalid. Please check the tracking number."
  const body = {
    order_list: orderSnList.map((order_sn) => ({
      order_sn,
      tracking_number: trackingByOrderSn[order_sn],
      shipping_document_type: typeByOrderSn[order_sn] ?? DEFAULT_SHIPPING_DOCUMENT_TYPE,
    })),
  };

  console.log(
    `[print-awb] create_shipping_document: sending ${orderSnList.length} order(s), full order_list payload:`
  );
  console.log(JSON.stringify(body, null, 2));

  const missingTracking = body.order_list.filter((entry) => !entry.tracking_number);
  if (missingTracking.length > 0) {
    // Should be unreachable: orders without tracking are filtered out earlier.
    console.error(
      '[print-awb] BUG: order_list contains entries without tracking_number:',
      JSON.stringify(missingTracking)
    );
  }

  let data;
  try {
    data = await shopeeJsonCall('create_shipping_document', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Shopee sets a top-level error when the whole batch fails, but it can also
    // set one while individual orders succeeded. Keep going if result_list
    // shows survivors; otherwise the error stands.
    const resultList = err instanceof ShopeeStepError ? err.shopeeResponse?.response?.result_list : null;
    if (!resultList || collectFailures(err.shopeeResponse).length === 0) throw err;
    data = err.shopeeResponse;
  }

  // Shopee reports per-order problems inside result_list while the top-level
  // message stays vague ("All failed, please check result_list for detail").
  const failed = collectFailures(data);

  // An order entirely absent from result_list — not flagged as failed, but
  // never confirmed either — is NOT the same as a success. Deriving `created`
  // as "everything minus what's explicitly failed" silently treats a missing
  // or partial result_list as full success; an empty result_list on a
  // nominally-OK response would then mark every requested order as created
  // with nothing to back that up (the mistake only surfaces later, and
  // misleadingly, in waitForDocumentReady). Anything Shopee didn't report on
  // at all is treated as failed here instead.
  const resultList = data?.response?.result_list ?? [];
  const presentSns = new Set(resultList.map((r) => r.order_sn));
  const missingFromResponse = orderSnList.filter((orderSn) => !presentSns.has(orderSn));

  if (missingFromResponse.length > 0) {
    console.error(
      `[print-awb] create_shipping_document: Shopee's result_list did not mention ${missingFromResponse.length}/${orderSnList.length} requested order(s) at all — treating as failed rather than assuming success:`,
      missingFromResponse.join(', ')
    );
    for (const orderSn of missingFromResponse) {
      failed.push({
        order_sn: orderSn,
        fail_error: null,
        fail_message: 'Shopee returned no result for this order',
      });
    }
  }

  const failedSns = new Set(failed.map((f) => f.order_sn));
  const created = orderSnList.filter((orderSn) => !failedSns.has(orderSn));

  if (failed.length > 0) {
    console.error(`[print-awb] create_shipping_document: ${failed.length} order(s) failed:`);
    console.error(JSON.stringify(failed, null, 2));
  }

  // Only give up when nothing survived — one bad order must not sink the batch.
  if (created.length === 0) {
    throw new ShopeeStepError(
      'create_shipping_document',
      describeFailures(failed) || 'Shopee rejected every order in the batch',
      data
    );
  }

  console.log(
    `[print-awb] create_shipping_document: requested for ${created.length}/${orderSnList.length} order(s): ${created.join(', ')}`
  );
  return { created, failed };
}

/**
 * Creates shipping documents, skipping get_shipping_document_parameter on the
 * assumption that every order takes OPTIMISTIC_SHIPPING_DOCUMENT_TYPE.
 *
 * Any order the optimistic attempt did not create — whether the whole call
 * threw or only some orders came back failed — triggers the lookup, and those
 * orders alone are retried with whatever type Shopee names. Retrying only the
 * unresolved ones matters: an order that already has a document must not be
 * sent through create a second time (see downloadOnePerOrder's note on why
 * re-creating risks losing a usable label).
 *
 * Returns the same { created, failed } shape as createShippingDocument plus
 * typeByOrderSn, which records the type ACTUALLY used per order — the
 * readiness poll has to match it or Shopee reports nothing for that order.
 */
async function createShippingDocumentsWithTypeFallback(store, orderSnList, trackingByOrderSn, perf) {
  const typeByOrderSn = Object.fromEntries(
    orderSnList.map((orderSn) => [orderSn, OPTIMISTIC_SHIPPING_DOCUMENT_TYPE])
  );

  let created = [];
  let failed = [];
  let optimisticError = null;

  const optimisticDone = perf.start('create_shipping_document[optimistic]');
  try {
    const result = await createShippingDocument(store, orderSnList, typeByOrderSn, trackingByOrderSn);
    created = result.created;
    failed = result.failed;
  } catch (err) {
    // Total rejection. Not fatal yet — the fallback below may still succeed
    // with the type Shopee actually wants.
    optimisticError = err;
  }
  optimisticDone();

  const unresolved = orderSnList.filter((orderSn) => !created.includes(orderSn));

  if (unresolved.length === 0) {
    console.log(
      `[print-awb][path] RESULT=doc_type_optimistic orders=${created.length} type=${OPTIMISTIC_SHIPPING_DOCUMENT_TYPE} (skipped get_shipping_document_parameter)`
    );
    return { created, failed, typeByOrderSn };
  }

  console.log(
    `[print-awb][path] RESULT=doc_type_fallback unresolved=${unresolved.length}/${orderSnList.length} assumed=${OPTIMISTIC_SHIPPING_DOCUMENT_TYPE}`
  );
  console.error(
    `[print-awb] ${OPTIMISTIC_SHIPPING_DOCUMENT_TYPE} not accepted for: ${unresolved.join(', ')} — falling back to get_shipping_document_parameter`
  );
  // The raw reason, so a courier that genuinely needs another type is
  // identifiable from the logs rather than inferred.
  if (optimisticError) {
    console.error('[print-awb] optimistic create_shipping_document threw:', optimisticError.message);
    console.error(
      '[print-awb] raw Shopee response:',
      JSON.stringify(optimisticError.shopeeResponse ?? { message: optimisticError.message }, null, 2)
    );
  }
  if (failed.length > 0) {
    console.error('[print-awb] optimistic create per-order failures:');
    console.error(JSON.stringify(failed, null, 2));
  }

  const typesDone = perf.start('get_shipping_document_parameter[fallback]');
  const lookedUpTypes = await getShippingDocumentTypes(store, unresolved);
  typesDone();

  // Record what the retry will actually send, including the default for any
  // order the lookup had nothing to say about.
  for (const orderSn of unresolved) {
    typeByOrderSn[orderSn] = lookedUpTypes[orderSn] ?? DEFAULT_SHIPPING_DOCUMENT_TYPE;
  }
  console.log(
    '[print-awb] retrying create with looked-up types:',
    unresolved.map((orderSn) => `${orderSn}=${typeByOrderSn[orderSn]}`).join(', ')
  );

  const retryDone = perf.start('create_shipping_document[retry]');
  let retryResult = null;
  let retryError = null;
  try {
    retryResult = await createShippingDocument(store, unresolved, lookedUpTypes, trackingByOrderSn);
  } catch (err) {
    retryError = err;
  }
  retryDone();

  if (retryError) {
    // Nothing survived either attempt: surface the retry's error, since it
    // carries the rejection reason for the type Shopee itself suggested.
    if (created.length === 0) throw retryError;

    // Some orders did create optimistically — keep them rather than sinking
    // the whole batch, and report the rest as failed exactly as before.
    return {
      created,
      failed: unresolved.map((orderSn) => ({
        order_sn: orderSn,
        fail_error: null,
        fail_message: retryError.message,
      })),
      typeByOrderSn,
    };
  }

  // Every order in `failed` from the optimistic pass is by definition in
  // `unresolved`, so the retry's outcome supersedes it wholesale.
  return {
    created: [...created, ...retryResult.created],
    failed: retryResult.failed,
    typeByOrderSn,
  };
}

// maxStatusRetries defaults to MAX_STATUS_RETRIES so the print endpoint keeps
// its original behaviour exactly; the cron prefetch passes a smaller budget,
// since each extra attempt costs a fixed STATUS_RETRY_DELAY_MS sleep it cannot
// afford inside the shared 50s window.
async function waitForDocumentReady(
  store,
  orderSnList,
  typeByOrderSn = {},
  perf,
  maxStatusRetries = MAX_STATUS_RETRIES
) {
  const path = '/api/v2/logistics/get_shipping_document_result';

  // This request takes shipping_document_type but NOT tracking_number; it must
  // match the type used to create the document.
  const body = {
    order_list: orderSnList.map((order_sn) => ({
      order_sn,
      shipping_document_type: typeByOrderSn[order_sn] ?? DEFAULT_SHIPPING_DOCUMENT_TYPE,
    })),
  };

  console.log('[print-awb] get_shipping_document_result request body:');
  console.log(JSON.stringify(body, null, 2));

  let lastData = null;

  for (let attempt = 1; attempt <= maxStatusRetries; attempt += 1) {
    const url = buildSignedUrl(path, store);

    console.log(`[print-awb] checking document status (attempt ${attempt}/${maxStatusRetries})`);

    const pollDone = perf.start(`get_shipping_document_result[poll ${attempt}]`);
    const data = await shopeeJsonCall('get_shipping_document_result', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    pollDone();

    lastData = data;

    const resultList = data.response?.result_list ?? [];
    console.log(
      '[print-awb] document statuses:',
      resultList.map((r) => `${r.order_sn}=${r.status}`).join(', ') || '(empty)'
    );

    // Distinct from "still processing": Shopee returned nothing at all for an
    // order_list we just asked about — not a mid-generation status, and not
    // something a retry can fix, since an unchanging request shape will just
    // come back empty again. Failing fast here instead of falling into the
    // "still processing" branch below avoids burning the whole retry budget
    // on a response that was never going to look any different, and avoids
    // reporting a misleading "still processing after maximum retries" when
    // the real story is "Shopee never acknowledged these orders at all".
    if (resultList.length === 0) {
      throw new ShopeeStepError(
        'get_shipping_document_result',
        `Shopee returned no document status entries for any of the ${orderSnList.length} requested order(s)`,
        data
      );
    }

    const failed = resultList
      .filter((r) => r.status === 'FAILED' || r.fail_error || r.fail_message)
      .map((entry) => ({
        order_sn: entry.order_sn,
        fail_error: entry.fail_error ?? null,
        fail_message: entry.fail_message ?? null,
      }));

    const ready = resultList.filter((r) => r.status === 'READY').map((r) => r.order_sn);
    const stillProcessing = resultList.filter((r) => r.status === 'PROCESSING').map((r) => r.order_sn);

    // Settled once nothing is still processing: a failed order shouldn't block
    // the ones whose labels are ready.
    if (resultList.length > 0 && stillProcessing.length === 0) {
      if (failed.length > 0) {
        console.error(`[print-awb] ${failed.length} document(s) FAILED to generate:`);
        console.error(JSON.stringify(failed, null, 2));
      }

      if (ready.length === 0) {
        throw new ShopeeStepError(
          'get_shipping_document_result',
          describeFailures(failed) || 'Shopee failed to generate the shipping document',
          data
        );
      }

      console.log(`[print-awb] ${ready.length}/${orderSnList.length} document(s) READY: ${ready.join(', ')}`);
      return { ready, failed };
    }

    console.log(`[print-awb] still processing: ${stillProcessing.join(', ') || '(unknown)'}`);

    if (attempt < maxStatusRetries) {
      await sleep(STATUS_RETRY_DELAY_MS);
    }
  }

  throw new ShopeeStepError(
    'get_shipping_document_result',
    'Shipping document still processing after maximum retries',
    lastData
  );
}

async function downloadShippingDocument(store, orderSnList) {
  const path = '/api/v2/logistics/download_shipping_document';
  const url = buildSignedUrl(path, store);

  const body = { order_list: orderSnList.map((order_sn) => ({ order_sn })) };

  console.log('[print-awb] downloading shipping document for', orderSnList.length, 'order(s)');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get('content-type') || '';

  // Shopee returns JSON (not a PDF) when something went wrong.
  if (contentType.includes('application/json')) {
    const bodyText = await response.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = { _unparsed_body: bodyText };
    }
    console.error(`[print-awb] download_shipping_document: HTTP ${response.status} raw response:`);
    console.error(JSON.stringify(data, null, 2));
    throw new ShopeeStepError(
      'download_shipping_document',
      data.message || 'Failed to download Shopee shipping document',
      data
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  if (!response.ok || pdfBuffer.length === 0) {
    console.error(
      `[print-awb] download_shipping_document: HTTP ${response.status}, content-type ${contentType}, bytes ${pdfBuffer.length}`
    );
    // Not JSON and not a usable PDF — surface whatever it actually sent.
    const preview = pdfBuffer.toString('utf8').slice(0, 500);
    console.error('[print-awb] body preview:', preview || '(empty)');
    throw new ShopeeStepError(
      'download_shipping_document',
      `Failed to download Shopee shipping document (HTTP ${response.status})`,
      { http_status: response.status, content_type: contentType, body_preview: preview }
    );
  }

  console.log('[print-awb] downloaded PDF, bytes:', pdfBuffer.length);
  return pdfBuffer;
}

/**
 * Shopee refuses to put packages from different logistics channels into one
 * document, e.g. "SPX Express (West Malaysia)" and "Self Collection Point
 * (SPX Express)". The Bulk Print page sends one store + one courier per call,
 * so this should not normally fire — but courier_name only approximates
 * Shopee's channel, so the per-order fallback below remains the safety net.
 */
const CANNOT_DOWNLOAD_TOGETHER = 'packages_can_not_download_together';

function isCannotDownloadTogether(err) {
  if (!(err instanceof ShopeeStepError)) return false;
  const haystack = `${err.message} ${JSON.stringify(err.shopeeResponse ?? {})}`;
  return haystack.includes(CANNOT_DOWNLOAD_TOGETHER);
}

function toFailedEntry(failure) {
  return {
    order_sn: failure.order_sn,
    reason: failure.fail_message || failure.fail_error || 'Shopee rejected this order',
  };
}

/**
 * Downloads one PDF per order. Used when Shopee refuses to emit a combined
 * document. The documents already exist and are READY at this point, so this
 * only repeats the download step — re-running create would risk Shopee
 * rejecting an already-created document and losing a usable label.
 */
async function downloadOnePerOrder(store, orderSnList) {
  console.log(`[print-awb] downloading one PDF per order (${orderSnList.length} order(s))`);

  const documents = [];
  const failed = [];

  for (const orderSn of orderSnList) {
    try {
      const pdfBuffer = await downloadShippingDocument(store, [orderSn]);
      documents.push({
        order_sn_list: [orderSn],
        order_count: 1,
        filename: `AWB-${orderSn}.pdf`,
        pdf_base64: pdfBuffer.toString('base64'),
      });
      console.log(`[print-awb] per-order download: ${orderSn} ok`);
    } catch (err) {
      console.error(`[print-awb] per-order download: ${orderSn} failed:`, err.message);
      failed.push({ order_sn: orderSn, reason: err.message });
    }
  }

  return { documents, failed };
}

// --- Reprint fast path -------------------------------------------------------
//
// Shopee keeps a created shipping document downloadable for a while, so a
// REPRINT can skip get_shipping_document_parameter, create_shipping_document
// and the readiness poll and just re-download. Measured: 1609ms vs 3679ms for
// the full pipeline on a same-day reprint.
//
// Documents do expire — a month-old COMPLETED order came back as a 234-byte
// error body, not a PDF. So the shortcut is strictly best-effort: anything
// that isn't a genuine PDF falls through to the full pipeline, and the user
// sees today's normal speed rather than an error.

// A PDF always begins with these bytes. Checked instead of HTTP status or
// byte count alone because Shopee's refusals come back as a 200 with a short
// JSON/text body, which both of those would happily wave through.
const PDF_MAGIC = '%PDF-';

function looksLikePdf(buffer) {
  return buffer.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

/**
 * Re-downloads an existing shipping document with no create/poll first.
 * Returns a Buffer only when the response is genuinely a PDF; returns null on
 * every other outcome (expired document, Shopee refusal, network error,
 * non-PDF body). Never throws — a failed shortcut must be invisible to the
 * caller, which then runs the full pipeline as normal.
 *
 * Separate from downloadShippingDocument() above on purpose: that one throws
 * ShopeeStepError to surface a real failure to the user, which is exactly the
 * wrong behaviour here, where a failure is an expected, silent miss.
 */
async function tryReprintDownload(store, orderSnList) {
  const path = '/api/v2/logistics/download_shipping_document';
  const url = buildSignedUrl(path, store);
  const body = { order_list: orderSnList.map((order_sn) => ({ order_sn })) };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    if (!looksLikePdf(buffer)) {
      // Expected outcome once a document has expired — logged at log level,
      // not error: the full pipeline is about to handle this correctly.
      console.log(
        `[print-awb] reprint download not usable: HTTP ${response.status}, content-type "${contentType}", ${buffer.length} bytes, no %PDF- header`
      );
      console.log('[print-awb] reprint response preview:', buffer.toString('utf8').slice(0, 300) || '(empty)');
      return null;
    }

    if (!response.ok) {
      console.log(`[print-awb] reprint download looked like a PDF but HTTP was ${response.status}; ignoring`);
      return null;
    }

    return buffer;
  } catch (err) {
    console.log('[print-awb] reprint download failed, falling back to full pipeline:', err.message);
    return null;
  }
}

// --- Public surface ----------------------------------------------------------
// Moved verbatim out of api/shopee/print-awb.js so both the HTTP endpoint and
// the cron prefetch can drive the same pipeline. The endpoint's behaviour is
// unchanged: the only edit made during the move was adding the optional
// maxStatusRetries argument to waitForDocumentReady (default 5 = previous
// behaviour), which the prefetch lowers to stay inside the cron budget.
//
// Log lines still carry the [print-awb] prefix, including when called from
// cron. Keeping them identical was the point — grep patterns built against
// these logs keep working. Callers add their own prefixed context lines.
export {
  ShopeeStepError,
  makePerfTracker,
  ensureFreshToken,
  buildSignedUrl,
  shopeeJsonCall,
  collectFailures,
  describeFailures,
  loadOrderPrintState,
  resolveTrackingNumbers,
  persistTrackingNumbers,
  createShippingDocumentsWithTypeFallback,
  waitForDocumentReady,
  downloadShippingDocument,
  downloadOnePerOrder,
  tryReprintDownload,
  looksLikePdf,
  isCannotDownloadTogether,
  toFailedEntry,
  NO_TRACKING_REASON,
  CANNOT_DOWNLOAD_TOGETHER,
  DEFAULT_SHIPPING_DOCUMENT_TYPE,
  OPTIMISTIC_SHIPPING_DOCUMENT_TYPE,
  MAX_STATUS_RETRIES,
};
