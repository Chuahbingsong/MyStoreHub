import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from '../_lib/shopee.js';
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { withCors } from '../_lib/cors.js';

const MAX_STATUS_RETRIES = 5;
const STATUS_RETRY_DELAY_MS = 2000;

// Used when Shopee doesn't tell us which document type an order supports.
const DEFAULT_SHIPPING_DOCUMENT_TYPE = 'NORMAL_AIR_WAYBILL';

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

/**
 * Resolves a tracking number for each order. Orders without one can't have a
 * label created, so they're reported as skipped rather than poisoning the
 * whole batch.
 */
async function resolveTrackingNumbers(store, orderSnList, perf) {
  const trackingByOrderSn = {};
  const skipped = [];

  for (const orderSn of orderSnList) {
    const done = perf.start(`get_tracking_number[${orderSn}]`);
    const trackingNumber = await getTrackingNumber(store, orderSn);
    done();
    if (trackingNumber) {
      trackingByOrderSn[orderSn] = trackingNumber;
    } else {
      console.error(`[print-awb] ${orderSn}: ${NO_TRACKING_REASON} — skipping`);
      skipped.push({ order_sn: orderSn, reason: NO_TRACKING_REASON });
    }
  }

  console.log('[print-awb] tracking numbers resolved:');
  console.log(JSON.stringify({ tracking: trackingByOrderSn, skipped }, null, 2));

  return { trackingByOrderSn, skipped };
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

async function waitForDocumentReady(store, orderSnList, typeByOrderSn = {}, perf) {
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

  for (let attempt = 1; attempt <= MAX_STATUS_RETRIES; attempt += 1) {
    const url = buildSignedUrl(path, store);

    console.log(`[print-awb] checking document status (attempt ${attempt}/${MAX_STATUS_RETRIES})`);

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

    if (attempt < MAX_STATUS_RETRIES) {
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

export default withCors(handler);

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
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
    console.error('[print-awb] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, order_sn_list } = req.body ?? {};

  if (!store_id) {
    return res.status(400).json({ success: false, error: 'store_id is required' });
  }

  if (!Array.isArray(order_sn_list) || order_sn_list.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: 'order_sn_list must be a non-empty array' });
  }

  const { data: store, error: storeLookupError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('id', store_id)
    .eq('platform', 'shopee')
    .maybeSingle();

  if (storeLookupError) {
    console.error('[print-awb] failed to load store', storeLookupError);
    return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
  }

  if (!store) {
    return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
  }

  if (store.user_id !== user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const requestStart = Date.now();
  const perf = makePerfTracker();
  try {
    const tokenDone = perf.start('ensureFreshToken');
    const freshStore = await ensureFreshToken(store);
    tokenDone();

    console.log('[print-awb] printing AWB for store', store.id, 'orders:', order_sn_list.join(', '));

    // 1. Resolve a tracking number per order; create_shipping_document
    //    validates it, so orders without one cannot be printed.
    const trackingDone = perf.start(`resolveTrackingNumbers[${order_sn_list.length} order(s), sequential]`);
    const { trackingByOrderSn, skipped } = await resolveTrackingNumbers(freshStore, order_sn_list, perf);
    trackingDone();
    const persistDone = perf.start('persistTrackingNumbers');
    await persistTrackingNumbers(store.id, trackingByOrderSn);
    persistDone();
    const printableOrderSns = order_sn_list.filter((orderSn) => trackingByOrderSn[orderSn]);

    if (printableOrderSns.length === 0) {
      console.error('[print-awb] no orders have a tracking number; nothing to print');
      return res.status(422).json({
        success: false,
        step: 'get_tracking_number',
        error: NO_TRACKING_REASON,
        skipped_orders: skipped,
        shopee_response: null,
      });
    }

    // 2. The caller sends one store + one logistics channel per request, so
    //    this is a single create -> poll -> download run.
    const typesDone = perf.start('get_shipping_document_parameter');
    const typeByOrderSn = await getShippingDocumentTypes(freshStore, printableOrderSns);
    typesDone();

    const createDone = perf.start('create_shipping_document');
    const { created, failed: createFailed } = await createShippingDocument(
      freshStore,
      printableOrderSns,
      typeByOrderSn,
      trackingByOrderSn
    );
    createDone();

    const waitDone = perf.start('waitForDocumentReady[total]');
    const { ready, failed: resultFailed } = await waitForDocumentReady(
      freshStore,
      created,
      typeByOrderSn,
      perf
    );
    waitDone();

    const failed = [...createFailed, ...resultFailed].map(toFailedEntry);

    // 3. Download the batch as one PDF, falling back to one PDF per order if
    //    Shopee still refuses to combine them.
    let documents = [];
    const downloadDone = perf.start('download_shipping_document');
    try {
      const pdfBuffer = await downloadShippingDocument(freshStore, ready);
      downloadDone();
      documents = [
        {
          order_sn_list: ready,
          order_count: ready.length,
          pdf_base64: pdfBuffer.toString('base64'),
        },
      ];
    } catch (err) {
      downloadDone();
      if (!isCannotDownloadTogether(err) || ready.length <= 1) throw err;

      console.error(
        `[print-awb] batch download hit ${CANNOT_DOWNLOAD_TOGETHER}; retrying one order at a time`
      );

      const perOrder = await downloadOnePerOrder(freshStore, ready);
      if (perOrder.documents.length === 0) throw err;

      documents = perOrder.documents;
      failed.push(...perOrder.failed);
    }

    console.log(`[print-awb][perf] REQUEST TOTAL: ${Date.now() - requestStart}ms`);
    perf.summary();

    const printedOrderSns = documents.flatMap((doc) => doc.order_sn_list);

    // 4. NOT marked as printed here. Generating the label PDF is not the same
    //    as it reaching the seller's device — a Capacitor WebView blob
    //    download used to silently no-op, yet this endpoint still reported
    //    success and the order got marked printed regardless. The client now
    //    calls /api/shopee/confirm-awb-printed once it has actually saved or
    //    downloaded the PDF; see api/_lib/awbPrinted.js.

    console.log(
      `[print-awb] done: ${documents.length} document(s), ${printedOrderSns.length} printed, ${failed.length} failed, ${skipped.length} skipped`
    );

    // 5. A lone clean order comes back as an inline PDF.
    if (
      documents.length === 1 &&
      documents[0].order_count === 1 &&
      failed.length === 0 &&
      skipped.length === 0
    ) {
      console.log('[print-awb] returning inline PDF for single order');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="awb-${printedOrderSns[0]}.pdf"`);
      return res.status(200).send(Buffer.from(documents[0].pdf_base64, 'base64'));
    }

    // One document is the normal case; `documents` only appears when the
    // per-order fallback produced several PDFs.
    if (documents.length === 1) {
      console.log('[print-awb] returning single base64 PDF');
      return res.status(200).json({
        success: true,
        printed_order_sn_list: printedOrderSns,
        pdf_base64: documents[0].pdf_base64,
        failed,
        skipped_orders: skipped,
      });
    }

    console.log(`[print-awb] returning ${documents.length} per-order PDFs as base64`);
    return res.status(200).json({
      success: true,
      printed_order_sn_list: printedOrderSns,
      documents,
      failed,
      skipped_orders: skipped,
    });
  } catch (err) {
    const step = err instanceof ShopeeStepError ? err.step : 'unknown';
    const shopeeResponse = err instanceof ShopeeStepError ? err.shopeeResponse : null;

    console.log(`[print-awb][perf] REQUEST TOTAL (failed): ${Date.now() - requestStart}ms`);
    perf.summary();

    console.error(`[print-awb] print failed at step "${step}":`, err.message);
    if (shopeeResponse) {
      console.error('[print-awb] full Shopee response for failed step:');
      console.error(JSON.stringify(shopeeResponse, null, 2));
    } else {
      console.error(err);
    }

    return res.status(502).json({
      success: false,
      step,
      error: err.message,
      shopee_response: shopeeResponse,
    });
  }
}
