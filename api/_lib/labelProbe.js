// =============================================================================
// TEMPORARY DEBUG PROBE — DELETE BEFORE SHIPPING AWB PRINTING
// =============================================================================
//
// Verifies the TikTok Shop and Lazada shipping-label API response shapes
// against LIVE accounts, so the printing pipeline is written against observed
// responses rather than documentation guesses. Nothing here is called by sync,
// cron, or any user-facing path — it only runs when someone hits
// ?action=probe with a valid session.
//
// It is READ-ONLY: every call is a GET, no order state is mutated, no Supabase
// row is written, and no label is marked printed.
//
// TO REMOVE (3 steps, no other file is affected):
//   1. Delete this file (api/_lib/labelProbe.js).
//   2. In api/tiktok.js: delete the `probeTikTokLabel` import and the
//      `if (action === 'probe')` line in handler(), and restore the unknown-
//      action message to "...?action=auth, ?action=callback or ?action=sync".
//   3. In api/lazada.js: same two deletions and the same message restore.
//
// Precedent: commits 9953790 ("temp: Lazada API probe") -> 4d1dea2 ("remove
// probe") did exactly this. Follow the same pattern.
//
// USAGE (Bearer session token, same auth as ?action=sync):
//   GET|POST /api/lazada?action=probe[&order_id=<platform_order_id>]
//   GET|POST /api/tiktok?action=probe[&order_id=<platform_order_id>]
// order_id is optional — without it, the probe picks the newest label-eligible
// order itself. Both methods are accepted so the probe can be driven from a
// browser fetch as easily as from curl.
//
// LOGGING NOTE: every raw response body is logged in full EXCEPT the base64
// label payload itself (Lazada's data.document.file), which is replaced with a
// length marker — a multi-megabyte base64 blob in the Vercel log would bury
// the fields we are actually here to read. The decoded head of that payload is
// reported separately, which is the part that answers the question.
// =============================================================================

import { supabaseAdmin } from './supabaseAdmin.js';
import {
  LAZADA_APP_KEY,
  generateSign as lazadaSign,
  getValidLazadaToken,
} from './lazada.js';
import {
  TIKTOK_APP_KEY,
  TIKTOK_API_BASE,
  generateSign as tiktokSign,
  getValidTikTokToken,
} from './tiktok.js';

/* ------------------------------ shared helpers ------------------------------ */

// Duplicated from lazadaSync.js rather than exported from it: this file is
// temporary and must not leave a permanent import edge into sync code that a
// later revert would have to unpick.
const LAZADA_COUNTRY_GATEWAYS = {
  MY: 'https://api.lazada.com.my/rest',
  SG: 'https://api.lazada.sg/rest',
  TH: 'https://api.lazada.co.th/rest',
  ID: 'https://api.lazada.co.id/rest',
  PH: 'https://api.lazada.com.ph/rest',
  VN: 'https://api.lazada.vn/rest',
};

const LAZADA_ORDER_ITEMS_PATH = '/orders/items/get';
const LAZADA_DOCUMENT_PATH = '/order/document/get';

const TIKTOK_ORDER_DETAIL_PATH = '/order/202309/orders';

// The statuses each platform's label call is expected to require. Stored raw
// in orders.order_status by tiktokSync.js / lazadaSync.js, so these are the
// platforms' own vocabularies, not the app's canonical labels.
const LAZADA_LABEL_STATUSES = ['ready_to_ship', 'packed'];
const TIKTOK_LABEL_STATUSES = ['AWAITING_COLLECTION'];

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * What a decoded document actually is. The whole point of the Lazada half of
 * this probe: a PDF merges with pdf-lib, HTML does not merge at all.
 */
function sniffBytes(buffer) {
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head === '%PDF-') return 'pdf';

  const textHead = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (textHead.startsWith('<html') || textHead.startsWith('<!doctype html')) return 'html';
  if (textHead.startsWith('<')) return 'markup (not <html>)';
  if (head.startsWith('PK')) return 'zip';
  if (head.startsWith('\x89PNG')) return 'png';
  return 'unknown';
}

function firstChars(buffer, n = 200) {
  return buffer.subarray(0, n).toString('utf8');
}

/**
 * Key names only, so an unexpected field name is visible without dumping (or
 * leaking) buyer data. This is how the package-id field name gets identified.
 */
function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

/**
 * Finds one order to probe with. Prefers an explicit order_id, otherwise the
 * newest order sitting in a label-eligible status. When nothing matches, the
 * statuses that DO exist come back too — "no candidate" is otherwise
 * indistinguishable from "the probe is broken".
 */
async function pickCandidateOrder(platform, storeIds, statuses, explicitOrderId) {
  if (explicitOrderId) {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('id, store_id, platform_order_id, order_status, tracking_number, courier_name')
      .eq('platform', platform)
      .in('store_id', storeIds)
      .eq('platform_order_id', String(explicitOrderId))
      .maybeSingle();

    if (error) return { error: `Failed to load order: ${error.message}` };
    if (!data) return { error: `No ${platform} order ${explicitOrderId} found under your stores` };
    return { order: data };
  }

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('id, store_id, platform_order_id, order_status, tracking_number, courier_name')
    .eq('platform', platform)
    .in('store_id', storeIds)
    .in('order_status', statuses)
    .order('order_created_at', { ascending: false })
    .limit(1);

  if (error) return { error: `Failed to query candidates: ${error.message}` };
  if (data && data.length > 0) return { order: data[0] };

  const { data: all } = await supabaseAdmin
    .from('orders')
    .select('order_status')
    .eq('platform', platform)
    .in('store_id', storeIds)
    .limit(500);

  const counts = {};
  for (const row of all ?? []) {
    counts[row.order_status ?? '(null)'] = (counts[row.order_status ?? '(null)'] ?? 0) + 1;
  }

  return {
    error: `No ${platform} order in status ${statuses.join(' or ')}`,
    statuses_present: counts,
    hint: 'Pass ?order_id=<platform_order_id> to probe a specific order anyway.',
  };
}

/* --------------------------------- Lazada ---------------------------------- */

/**
 * Replaces the base64 label payload with a length marker so the surrounding
 * fields stay readable in the log. Shallow-copies only the path it rewrites —
 * everything else is the original object.
 */
function redactLazadaFile(body) {
  const file = body?.data?.document?.file;
  if (typeof file !== 'string') return body;

  return {
    ...body,
    data: {
      ...body.data,
      document: {
        ...body.data.document,
        file: `<base64 redacted for logging — ${file.length} chars>`,
      },
    },
  };
}

/**
 * One signed Lazada GET that CAPTURES failures instead of throwing.
 *
 * Deliberately different from lazadaSync.js's lazadaGet, which throws on a
 * non-"0" code. Error codes are the probe's output, not its failure mode —
 * error 30012 ("must be packed or ready to ship") is a result worth reporting,
 * not an exception to propagate.
 *
 * Follows the two confirmed Lazada conventions in lazadaSync.js: access_token
 * is part of the signature base string, and success is the STRING "0".
 */
async function lazadaGetRaw(host, path, accessToken, params, label) {
  const signedParams = {
    app_key: LAZADA_APP_KEY,
    access_token: accessToken,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    ...params,
  };
  const sign = lazadaSign(path, signedParams);
  const url = `${host}${path}?${new URLSearchParams({ ...signedParams, sign }).toString()}`;

  console.log(`[label-probe][lazada] ${label}: GET ${host}${path} params=${JSON.stringify(params)}`);

  let response;
  let text;
  try {
    response = await fetch(url);
    text = await response.text();
  } catch (err) {
    console.error(`[label-probe][lazada] ${label}: network error`, err.message);
    return { label, network_error: err.message, ok: false };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _unparsed_body: text };
  }

  console.log(`[label-probe][lazada] ${label}: HTTP ${response.status} raw response:`);
  console.log(JSON.stringify(redactLazadaFile(body), null, 2));

  return {
    label,
    http_status: response.status,
    code: body.code ?? null,
    message: body.message ?? null,
    detail: body.detail ?? null,
    request_id: body.request_id ?? null,
    ok: body.code === '0',
    body,
  };
}

/**
 * Runs one /order/document/get attempt for a given doc_type and reports what
 * came back — mime_type, document_type, and what the payload DECODES to.
 */
async function probeLazadaDocType(host, token, docType, orderItemIds) {
  const result = await lazadaGetRaw(
    host,
    LAZADA_DOCUMENT_PATH,
    token,
    { doc_type: docType, order_item_ids: JSON.stringify(orderItemIds) },
    `order/document/get[doc_type=${docType}]`
  );

  const report = {
    doc_type_requested: docType,
    accepted: result.ok,
    http_status: result.http_status ?? null,
    code: result.code,
    message: result.message,
    detail: result.detail,
    // Called out by name because it is the documented "order item is not in a
    // printable status" rejection, and is the most likely non-shape failure.
    is_error_30012: String(result.code) === '30012',
    network_error: result.network_error ?? null,
  };

  const doc = result.body?.data?.document;
  if (!doc) {
    report.document_present = false;
    return report;
  }

  report.document_present = true;
  report.mime_type = doc.mime_type ?? null;
  report.document_type = doc.document_type ?? null;
  report.document_keys = keysOf(doc);

  if (typeof doc.file !== 'string' || doc.file.length === 0) {
    report.file_present = false;
    return report;
  }

  report.file_present = true;
  report.file_base64_length = doc.file.length;

  const decoded = Buffer.from(doc.file, 'base64');
  report.decoded_byte_length = decoded.length;
  report.decoded_sniff = sniffBytes(decoded);
  report.starts_with_pdf_magic = decoded.subarray(0, 5).toString('latin1') === '%PDF-';
  report.decoded_first_200_chars = firstChars(decoded, 200);

  console.log(
    `[label-probe][lazada] doc_type=${docType}: mime_type=${report.mime_type} document_type=${report.document_type} ` +
      `decoded=${report.decoded_byte_length} bytes sniff=${report.decoded_sniff}`
  );
  console.log(`[label-probe][lazada] doc_type=${docType} decoded first 200 chars:`);
  console.log(report.decoded_first_200_chars);

  return report;
}

/**
 * Lazada label probe. Answers, in order:
 *   1. does /orders/items/get expose order_item_id, and any package_id?
 *   2. what does /order/document/get?doc_type=shippingLabel actually return?
 *   3. do the shippingLabelPdf / PDF doc_type variants exist?
 *
 * Question 2 is the one that decides whether the merged Print All can include
 * Lazada at all: pdf-lib can concatenate a PDF and cannot render HTML.
 */
export async function probeLazadaLabel(user, { orderId } = {}) {
  const report = { platform: 'lazada', probed_at: new Date().toISOString(), steps: {} };

  const { data: stores, error: storesError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'lazada')
    .eq('user_id', user.id);

  if (storesError) return { httpStatus: 500, body: { ...report, error: storesError.message } };
  if (!stores || stores.length === 0) {
    return { httpStatus: 404, body: { ...report, error: 'No connected Lazada stores for this user' } };
  }

  const candidate = await pickCandidateOrder(
    'lazada',
    stores.map((s) => s.id),
    LAZADA_LABEL_STATUSES,
    orderId
  );

  if (!candidate.order) {
    return { httpStatus: 404, body: { ...report, step: 'pick_candidate_order', ...candidate } };
  }

  const order = candidate.order;
  const store = stores.find((s) => s.id === order.store_id);
  report.order = {
    platform_order_id: order.platform_order_id,
    order_status: order.order_status,
    courier_name: order.courier_name,
    tracking_number_present: Boolean(order.tracking_number),
    store_id: order.store_id,
  };

  // Same store_id-first lookup lazadaSync.js's loadShopCredentials uses:
  // lazada_shops' unique key is (seller_id, country), so a seller connected in
  // two countries has two rows and a seller_id lookup alone is ambiguous.
  const { data: byStore } = await supabaseAdmin
    .from('lazada_shops')
    .select('seller_id, country')
    .eq('store_id', store.id)
    .maybeSingle();

  let shop = byStore;
  if (!shop) {
    const { data: bySeller } = await supabaseAdmin
      .from('lazada_shops')
      .select('seller_id, country')
      .eq('seller_id', String(store.shop_id));
    shop = bySeller?.[0] ?? null;
  }

  if (!shop) {
    return { httpStatus: 404, body: { ...report, error: `No lazada_shops row for store ${store.id}` } };
  }

  const country = (shop.country || 'MY').toUpperCase();
  const host = LAZADA_COUNTRY_GATEWAYS[country] ?? LAZADA_COUNTRY_GATEWAYS.MY;
  report.shop = { seller_id: shop.seller_id, country, gateway: host };

  let token;
  try {
    token = await getValidLazadaToken(shop.seller_id);
  } catch (err) {
    return { httpStatus: 502, body: { ...report, step: 'token', error: err.message } };
  }

  // --- Step 1: /orders/items/get ------------------------------------------
  // CONFIRMED in lazadaSync.js: the path is /orders/items/get (plural
  // "orders"), the parameter is order_ids as a NUMERIC JSON array, and the
  // response nests as data[] = { order_id, order_items[] }. Not the
  // /order/items/get + order_item_ids shape the public docs imply.
  const itemsResult = await lazadaGetRaw(
    host,
    LAZADA_ORDER_ITEMS_PATH,
    token,
    { order_ids: JSON.stringify([Number(order.platform_order_id)]) },
    'orders/items/get'
  );

  const itemsStep = {
    ok: itemsResult.ok,
    http_status: itemsResult.http_status ?? null,
    code: itemsResult.code,
    message: itemsResult.message,
    network_error: itemsResult.network_error ?? null,
  };

  const entries = Array.isArray(itemsResult.body?.data) ? itemsResult.body.data : [];
  const items = entries[0]?.order_items ?? [];
  itemsStep.entry_count = entries.length;
  itemsStep.item_count = items.length;
  itemsStep.first_item_keys = keysOf(items[0]);
  itemsStep.has_order_item_id = items.length > 0 && items[0].order_item_id != null;
  // Scanned rather than assumed: a package_id on the item would allow
  // per-package printing instead of per-order-item, which changes the cache key.
  itemsStep.package_like_keys = keysOf(items[0]).filter((k) => k.toLowerCase().includes('package'));
  itemsStep.per_item_statuses = items.map((i) => i.status ?? null);

  const orderItemIds = items.map((i) => i.order_item_id).filter((id) => id != null);
  itemsStep.order_item_ids = orderItemIds;
  report.steps.order_items = itemsStep;

  if (orderItemIds.length === 0) {
    return {
      httpStatus: 502,
      body: { ...report, error: 'No order_item_id values returned — cannot call /order/document/get' },
    };
  }

  // --- Step 2: /order/document/get, three doc_type variants ----------------
  // shippingLabel is the documented value. The other two are the candidates
  // that would return a PDF directly; if either works, the merge step needs no
  // conversion at all.
  report.steps.document = {};
  for (const docType of ['shippingLabel', 'shippingLabelPdf', 'PDF']) {
    report.steps.document[docType] = await probeLazadaDocType(host, token, docType, orderItemIds);
  }

  const shippingLabel = report.steps.document.shippingLabel;
  report.verdict = {
    mime_type: shippingLabel.mime_type ?? null,
    document_type: shippingLabel.document_type ?? null,
    decoded_as: shippingLabel.decoded_sniff ?? null,
    mergeable_with_pdf_lib: shippingLabel.starts_with_pdf_magic === true,
    pdf_variant_available: ['shippingLabelPdf', 'PDF'].filter(
      (t) => report.steps.document[t]?.starts_with_pdf_magic === true
    ),
  };

  console.log('[label-probe][lazada] VERDICT:', JSON.stringify(report.verdict));

  return { httpStatus: 200, body: report };
}

/* --------------------------------- TikTok ---------------------------------- */

/**
 * One signed TikTok GET that CAPTURES failures instead of throwing, for the
 * same reason lazadaGetRaw does. Follows the confirmed convention in
 * tiktokSync.js: errors arrive inside HTTP 200s, so body.code (numeric 0 for
 * success) is the real signal, and shop_cipher is required on every call.
 */
async function tiktokGetRaw(path, extraParams, shopCipher, accessToken, label) {
  const queryParams = {
    app_key: TIKTOK_APP_KEY,
    shop_cipher: shopCipher,
    timestamp: String(nowUnix()),
    ...extraParams,
  };
  const sign = tiktokSign(path, queryParams);
  const url = `${TIKTOK_API_BASE}${path}?${new URLSearchParams({ ...queryParams, sign }).toString()}`;

  console.log(`[label-probe][tiktok] ${label}: GET ${path} params=${JSON.stringify(extraParams)}`);

  let response;
  let text;
  try {
    response = await fetch(url, { headers: { 'x-tts-access-token': accessToken } });
    text = await response.text();
  } catch (err) {
    console.error(`[label-probe][tiktok] ${label}: network error`, err.message);
    return { label, network_error: err.message, ok: false };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _unparsed_body: text };
  }

  console.log(`[label-probe][tiktok] ${label}: HTTP ${response.status} raw response:`);
  console.log(JSON.stringify(body, null, 2));

  return {
    label,
    http_status: response.status,
    code: body.code ?? null,
    message: body.message ?? null,
    request_id: body.request_id ?? null,
    ok: body.code === 0,
    body,
  };
}

/**
 * Classifies a shipping_documents response without assuming the field name.
 * The recon's recalled shape was data.doc_url; this reports what is actually
 * there instead of looking only where it expected to find it.
 */
function classifyTikTokDocumentResponse(body) {
  const data = body?.data ?? {};
  const out = { data_keys: keysOf(data), url: null, url_field: null, base64_field: null, kind: 'unknown' };

  const walk = (obj, prefix) => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') {
        if (/^https?:\/\//i.test(value) && !out.url) {
          out.url = value;
          out.url_field = p;
        } else if (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 128))) {
          out.base64_field = out.base64_field ?? p;
        }
      } else if (value && typeof value === 'object') {
        walk(value, p);
      }
    }
  };
  walk(data, '');

  if (out.url) out.kind = 'url';
  else if (out.base64_field) out.kind = 'base64';
  else if (out.data_keys.length > 0) out.kind = 'other';

  return out;
}

/**
 * TikTok label probe. Answers, in order:
 *   1. what does an order's `packages` array actually look like — specifically
 *      the field name carrying the package id, which tiktokSync.js never
 *      persists and which the label call is keyed on;
 *   2. what /fulfillment/202309/packages/{id}/shipping_documents returns;
 *   3. whether document_format=PDF is accepted;
 *   4. whether a returned URL is fetchable without an auth header, and whether
 *      those bytes are a PDF.
 */
export async function probeTikTokLabel(user, { orderId } = {}) {
  const report = { platform: 'tiktok', probed_at: new Date().toISOString(), steps: {} };

  const { data: stores, error: storesError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('platform', 'tiktok')
    .eq('user_id', user.id);

  if (storesError) return { httpStatus: 500, body: { ...report, error: storesError.message } };
  if (!stores || stores.length === 0) {
    return { httpStatus: 404, body: { ...report, error: 'No connected TikTok stores for this user' } };
  }

  const candidate = await pickCandidateOrder(
    'tiktok',
    stores.map((s) => s.id),
    TIKTOK_LABEL_STATUSES,
    orderId
  );

  if (!candidate.order) {
    return { httpStatus: 404, body: { ...report, step: 'pick_candidate_order', ...candidate } };
  }

  const order = candidate.order;
  const store = stores.find((s) => s.id === order.store_id);
  report.order = {
    platform_order_id: order.platform_order_id,
    order_status: order.order_status,
    courier_name: order.courier_name,
    tracking_number_present: Boolean(order.tracking_number),
    store_id: order.store_id,
  };

  const { data: shop, error: shopError } = await supabaseAdmin
    .from('tiktok_shops')
    .select('shop_id, shop_cipher')
    .eq('shop_id', store.shop_id)
    .maybeSingle();

  if (shopError || !shop?.shop_cipher) {
    return {
      httpStatus: 404,
      body: { ...report, error: `No tiktok_shops row with shop_cipher for shop_id ${store.shop_id}` },
    };
  }
  report.shop = { shop_id: shop.shop_id, shop_cipher_present: true };

  let token;
  try {
    token = await getValidTikTokToken(store.shop_id);
  } catch (err) {
    return { httpStatus: 502, body: { ...report, step: 'token', error: err.message } };
  }

  // --- Step 1: order detail, for the packages array ------------------------
  const detailResult = await tiktokGetRaw(
    TIKTOK_ORDER_DETAIL_PATH,
    { ids: order.platform_order_id },
    shop.shop_cipher,
    token,
    'order/202309/orders[detail]'
  );

  const detailStep = {
    ok: detailResult.ok,
    http_status: detailResult.http_status ?? null,
    code: detailResult.code,
    message: detailResult.message,
    network_error: detailResult.network_error ?? null,
  };

  const tiktokOrder = detailResult.body?.data?.orders?.[0] ?? null;
  const packages = tiktokOrder?.packages ?? [];

  detailStep.order_keys = keysOf(tiktokOrder);
  detailStep.status = tiktokOrder?.status ?? null;
  detailStep.package_count = Array.isArray(packages) ? packages.length : 0;
  // Verbatim, as requested — packages carry ids and tracking numbers, not
  // buyer PII, so the whole array is safe to report and is the point of the
  // step. tiktokSync.js reads packages[0].tracking_number from a mapping
  // written without a live response; this is what confirms or refutes it.
  detailStep.packages_verbatim = packages;
  detailStep.first_package_keys = keysOf(packages[0]);
  // Fields that reveal whether this is TikTok Shipping (label available) or a
  // seller-shipped order (no label from the API at all).
  detailStep.shipping_type = tiktokOrder?.shipping_type ?? null;
  detailStep.fulfillment_type = tiktokOrder?.fulfillment_type ?? null;
  detailStep.delivery_option_name = tiktokOrder?.delivery_option_name ?? null;
  detailStep.shipping_provider_name = tiktokOrder?.shipping_provider_name ?? null;
  detailStep.tracking_number_on_order = tiktokOrder?.tracking_number ?? null;

  console.log('[label-probe][tiktok] packages array verbatim:');
  console.log(JSON.stringify(packages, null, 2));

  report.steps.order_detail = detailStep;

  if (!Array.isArray(packages) || packages.length === 0) {
    return {
      httpStatus: 502,
      body: {
        ...report,
        error: 'Order detail returned no packages — cannot call shipping_documents',
        note: 'An AWAITING_COLLECTION order with no packages would itself be a finding: it means the package id must come from elsewhere (e.g. GET /fulfillment/202309/orders/{id}/tracking).',
      },
    };
  }

  // The field name is discovered, not assumed — that discovery is the reason
  // this step exists. `id` is TikTok's documented name; package_id and
  // package_no are the plausible alternatives.
  const pkg = packages[0];
  const packageIdField = ['id', 'package_id', 'package_no'].find((k) => pkg[k] != null) ?? null;
  const packageId = packageIdField ? String(pkg[packageIdField]) : null;

  report.steps.package_id = { field_name: packageIdField, value: packageId };

  if (!packageId) {
    return {
      httpStatus: 502,
      body: { ...report, error: 'Could not identify a package id field', first_package_keys: keysOf(pkg) },
    };
  }

  // --- Step 2/3: shipping_documents, with and without document_format ------
  const documentPath = `/fulfillment/202309/packages/${packageId}/shipping_documents`;

  const baseResult = await tiktokGetRaw(
    documentPath,
    { document_type: 'SHIPPING_LABEL', document_size: 'A6' },
    shop.shop_cipher,
    token,
    'fulfillment/202309/shipping_documents[A6]'
  );

  const baseStep = {
    request: { document_type: 'SHIPPING_LABEL', document_size: 'A6' },
    ok: baseResult.ok,
    http_status: baseResult.http_status ?? null,
    code: baseResult.code,
    message: baseResult.message,
    network_error: baseResult.network_error ?? null,
    raw_body: baseResult.body ?? null,
    classification: classifyTikTokDocumentResponse(baseResult.body),
  };
  report.steps.shipping_documents = baseStep;

  const withFormat = await tiktokGetRaw(
    documentPath,
    { document_type: 'SHIPPING_LABEL', document_size: 'A6', document_format: 'PDF' },
    shop.shop_cipher,
    token,
    'fulfillment/202309/shipping_documents[A6+PDF]'
  );

  report.steps.shipping_documents_pdf_format = {
    request: { document_type: 'SHIPPING_LABEL', document_size: 'A6', document_format: 'PDF' },
    accepted: withFormat.ok,
    http_status: withFormat.http_status ?? null,
    code: withFormat.code,
    message: withFormat.message,
    network_error: withFormat.network_error ?? null,
    raw_body: withFormat.body ?? null,
    classification: classifyTikTokDocumentResponse(withFormat.body),
  };

  // --- Step 4: is the returned URL fetchable, and is it a PDF? -------------
  const docUrl =
    baseStep.classification.url ?? report.steps.shipping_documents_pdf_format.classification.url ?? null;

  if (docUrl) {
    console.log('[label-probe][tiktok] fetching doc_url with NO auth header:', docUrl);
    try {
      const docResponse = await fetch(docUrl);
      const bytes = Buffer.from(await docResponse.arrayBuffer());

      report.steps.doc_url_fetch = {
        url_field: baseStep.classification.url_field,
        http_status: docResponse.status,
        content_type: docResponse.headers.get('content-type'),
        byte_length: bytes.length,
        fetchable_without_auth: docResponse.ok && bytes.length > 0,
        starts_with_pdf_magic: bytes.subarray(0, 5).toString('latin1') === '%PDF-',
        sniff: sniffBytes(bytes),
        first_200_chars: firstChars(bytes, 200),
      };

      console.log(
        `[label-probe][tiktok] doc_url fetch: HTTP ${docResponse.status} ` +
          `content-type=${docResponse.headers.get('content-type')} bytes=${bytes.length} ` +
          `sniff=${report.steps.doc_url_fetch.sniff}`
      );
    } catch (err) {
      report.steps.doc_url_fetch = { url_field: baseStep.classification.url_field, network_error: err.message };
      console.error('[label-probe][tiktok] doc_url fetch failed:', err.message);
    }
  } else {
    report.steps.doc_url_fetch = { skipped: 'no URL found in the shipping_documents response' };
  }

  // TikTok's rejections are prose, not codes, so the message is matched rather
  // than parsed — these two cases change the design, not just the call.
  const messages = [baseResult.message, withFormat.message].filter(Boolean).join(' | ').toLowerCase();
  report.verdict = {
    response_kind: baseStep.classification.kind,
    url_field: baseStep.classification.url_field,
    pdf_format_accepted: withFormat.ok,
    label_is_pdf: report.steps.doc_url_fetch?.starts_with_pdf_magic ?? null,
    mergeable_with_pdf_lib: report.steps.doc_url_fetch?.starts_with_pdf_magic === true,
    looks_like_must_ship_first: /ship|not shipped|rts|ready to ship/.test(messages),
    looks_like_seller_shipping: /seller|self[- ]?ship|not.*tiktok shipping|unsupported/.test(messages),
    raw_messages: [baseResult.message, withFormat.message].filter(Boolean),
  };

  console.log('[label-probe][tiktok] VERDICT:', JSON.stringify(report.verdict));

  return { httpStatus: 200, body: report };
}

/* ------------------------------ HTTP entry points ---------------------------- */

/**
 * Bearer-session auth, identical to each function's ?action=sync handler.
 * GET and POST are both accepted (order_id from query or body) so the probe
 * can be driven from a browser fetch as easily as from curl; the auth itself
 * is unchanged either way.
 */
async function authenticate(req, res, label) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return null;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error(`[label-probe][${label}] auth verification failed`, authError);
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }

  return user;
}

export async function handleLazadaProbe(req, res) {
  const user = await authenticate(req, res, 'lazada');
  if (!user) return undefined;

  const orderId = req.query?.order_id ?? req.body?.order_id ?? null;
  console.log(`[label-probe][lazada] starting probe for user ${user.id}, order_id=${orderId ?? '(auto)'}`);

  try {
    const { httpStatus, body } = await probeLazadaLabel(user, { orderId });
    return res.status(httpStatus).json(body);
  } catch (err) {
    console.error('[label-probe][lazada] probe threw:', err);
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
}

export async function handleTikTokProbe(req, res) {
  const user = await authenticate(req, res, 'tiktok');
  if (!user) return undefined;

  const orderId = req.query?.order_id ?? req.body?.order_id ?? null;
  console.log(`[label-probe][tiktok] starting probe for user ${user.id}, order_id=${orderId ?? '(auto)'}`);

  try {
    const { httpStatus, body } = await probeTikTokLabel(user, { orderId });
    return res.status(httpStatus).json(body);
  } catch (err) {
    console.error('[label-probe][tiktok] probe threw:', err);
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
}
