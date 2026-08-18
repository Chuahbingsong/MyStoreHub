import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { withCors } from '../_lib/cors.js';
import { cacheEligibility } from '../_lib/awbCache.js';
import { fetchCachedPdfs, mergePdfBuffers, sortForMerge } from '../_lib/awbMerge.js';
import { printAllUnprinted } from '../_lib/awbPrintAll.js';

// Merging a large backlog is far heavier than a single label, and Hobby's
// default function ceiling would cut it off mid-run. 60s is the Hobby max.
export const config = { maxDuration: 60 };
import {
  CANNOT_DOWNLOAD_TOGETHER,
  NO_TRACKING_REASON,
  ShopeeStepError,
  createShippingDocumentsWithTypeFallback,
  downloadOnePerOrder,
  downloadShippingDocument,
  ensureFreshToken,
  isCannotDownloadTogether,
  loadOrderPrintState,
  makePerfTracker,
  persistTrackingNumbers,
  resolveTrackingNumbers,
  toFailedEntry,
  tryReprintDownload,
  waitForDocumentReady,
} from '../_lib/shopeeAwb.js';

/**
 * Serves prefetched labels out of Supabase Storage, or null to generate live.
 *
 * Works for one order or many. A multi-order request is merged server-side
 * into a single document with pdf-lib, so it comes back in exactly the shape
 * a live batch would and the client cannot tell the difference.
 *
 * ALL-OR-NOTHING: if any requested order fails its cache check, this returns
 * null and the whole batch is generated live. Cached and freshly-generated
 * labels are never stitched together in this path — a batch is entirely one
 * or entirely the other. (The Print All Unprinted sweep below is the
 * deliberate exception, and says so.)
 *
 * A single order is passed through unmerged, so that path stays byte-for-byte
 * what it was before merging existed.
 *
 * Never throws.
 */
async function tryServeFromCache(orderSnList, ordersByOrderSn) {
  const orders = [];

  for (const orderSn of orderSnList) {
    const order = ordersByOrderSn?.[orderSn];
    const eligibility = cacheEligibility(order);

    if (!eligibility.ok) {
      // fingerprint_mismatch carries the current field values; the field that
      // actually changed is not recoverable from a composite hash.
      console.log(
        `[print-awb][path] RESULT=cache_miss reason=${eligibility.reason} order=${orderSn} of=${orderSnList.length}` +
          (eligibility.detail ? ` detail=${eligibility.detail}` : '')
      );
      if (eligibility.reason === 'fingerprint_mismatch') {
        console.log(
          `[print-awb] cached fingerprint ${eligibility.expected} != current ${eligibility.actual} — regenerating`
        );
      }
      return null;
    }

    orders.push(order);
  }

  const sorted = sortForMerge(orders);
  const buffers = await fetchCachedPdfs(sorted);

  // One unreadable object means the batch is not fully cached, and mixing is
  // not allowed here — regenerate the lot.
  if (buffers.size !== sorted.length) {
    console.log(
      `[print-awb][path] RESULT=cache_miss reason=unreadable got=${buffers.size}/${sorted.length}`
    );
    return null;
  }

  const mergeStart = Date.now();
  const merged = await mergePdfBuffers(sorted.map((order) => buffers.get(order.platform_order_id)));
  if (!merged) {
    console.log('[print-awb][path] RESULT=cache_miss reason=merge_failed');
    return null;
  }

  if (sorted.length > 1) {
    console.log(
      `[print-awb][path] RESULT=merge source=cache orders=${sorted.length} merge_ms=${Date.now() - mergeStart} bytes=${merged.length}`
    );
  }

  return merged;
}

/**
 * Sends a PDF using the same two response shapes the full pipeline uses, so
 * the client needs no knowledge of which path produced it: a lone order comes
 * back as inline PDF bytes, anything else as base64 JSON.
 */
function sendAwbPdf(res, pdfBuffer, orderSnList) {
  if (orderSnList.length === 1) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="awb-${orderSnList[0]}.pdf"`);
    return res.status(200).send(pdfBuffer);
  }

  return res.status(200).json({
    success: true,
    printed_order_sn_list: orderSnList,
    pdf_base64: pdfBuffer.toString('base64'),
    failed: [],
    skipped_orders: [],
  });
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

  // >>> TEMPORARY PROBE BRANCH — DELETE ME (see PROBE block at end of file)
  // Read-only: calls get_shipping_parameter and returns what it says. Never
  // calls ship_order, never writes to any table. Placed after auth so it
  // inherits the same Bearer-token + ownership checks as every other path.
  if ((req.query?.action ?? req.body?.action) === 'probe_shipping') {
    const { httpStatus, body } = await probeShippingParameters(user, req.body?.store_id ?? null);
    return res.status(httpStatus).json(body);
  }
  // <<< END TEMPORARY PROBE BRANCH

  const { store_id, order_sn_list, print_all_unprinted } = req.body ?? {};

  // Cross-store sweep: resolves its own order list rather than taking one,
  // so it validates ownership per store below instead of up front. Branches
  // before every check the per-store paths do, leaving them untouched.
  if (print_all_unprinted) {
    const { httpStatus, body } = await printAllUnprinted(user);
    return res.status(httpStatus).json(body);
  }

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
    console.log('[print-awb] printing AWB for store', store.id, 'orders:', order_sn_list.join(', '));

    // One local read serving the Storage-cache check, the fast-path gate and
    // the tracking-number cache, so none of them costs a first-time print an
    // extra round trip. Runs before ensureFreshToken because a cache hit
    // needs no Shopee token at all.
    const stateDone = perf.start('loadOrderPrintState');
    const { trackingByOrderSn: storedTracking, allPrinted, ordersByOrderSn } =
      await loadOrderPrintState(store.id, order_sn_list);
    stateDone();

    // Storage cache: the only path that touches Shopee zero times. Strictly
    // best-effort — every rejection falls through to live generation, so the
    // worst case is the speed we had before the cache existed.
    const cacheStart = Date.now();
    const cachedBuffer = await tryServeFromCache(order_sn_list, ordersByOrderSn);
    if (cachedBuffer) {
      console.log(
        `[print-awb][path] RESULT=cache_hit orders=${order_sn_list.length} cache_ms=${Date.now() - cacheStart} total_ms=${Date.now() - requestStart} bytes=${cachedBuffer.length}`
      );
      return sendAwbPdf(res, cachedBuffer, order_sn_list);
    }

    const tokenDone = perf.start('ensureFreshToken');
    const freshStore = await ensureFreshToken(store);
    tokenDone();

    // Reprint fast path. Best-effort only: any miss falls through to the full
    // pipeline below with no visible difference to the user beyond latency.
    // The [path] lines are the hit-rate instrumentation — grep RESULT= to
    // count fast_path_hit vs fast_path_miss vs full_pipeline.
    let fastPathAttempted = false;
    if (allPrinted) {
      fastPathAttempted = true;
      const attemptStart = Date.now();
      const reprintBuffer = await tryReprintDownload(freshStore, order_sn_list);
      const attemptMs = Date.now() - attemptStart;

      if (reprintBuffer) {
        console.log(
          `[print-awb][path] RESULT=fast_path_hit orders=${order_sn_list.length} download_ms=${attemptMs} total_ms=${Date.now() - requestStart} bytes=${reprintBuffer.length}`
        );
        return sendAwbPdf(res, reprintBuffer, order_sn_list);
      }

      console.log(
        `[print-awb][path] RESULT=fast_path_miss orders=${order_sn_list.length} wasted_ms=${attemptMs} — falling back to full pipeline`
      );
    } else {
      console.log(
        `[print-awb][path] fast path not eligible (not all ${order_sn_list.length} order(s) previously printed)`
      );
    }

    const fullPipelineStart = Date.now();

    // 1. Resolve a tracking number per order; create_shipping_document
    //    validates it, so orders without one cannot be printed. Orders
    //    already carrying a tracking_number (e.g. a reprint) reuse it rather
    //    than re-asking Shopee; the rest are fetched with bounded concurrency.
    const trackingDone = perf.start(`resolveTrackingNumbers[${order_sn_list.length} order(s)]`);
    const { trackingByOrderSn, skipped, freshlyFetchedOrderSns } = await resolveTrackingNumbers(
      freshStore,
      storedTracking,
      order_sn_list,
      perf
    );
    trackingDone();
    // Only orders whose tracking number just came from Shopee need writing
    // back — anything reused from the cache is already correct in the table.
    if (freshlyFetchedOrderSns.length > 0) {
      const persistDone = perf.start('persistTrackingNumbers');
      await persistTrackingNumbers(
        store.id,
        Object.fromEntries(freshlyFetchedOrderSns.map((orderSn) => [orderSn, trackingByOrderSn[orderSn]]))
      );
      persistDone();
    }
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
    //    this is a single create -> poll -> download run. The document-type
    //    lookup is skipped unless Shopee rejects the assumed type.
    const {
      created,
      failed: createFailed,
      typeByOrderSn,
    } = await createShippingDocumentsWithTypeFallback(
      freshStore,
      printableOrderSns,
      trackingByOrderSn,
      perf
    );

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

    console.log(
      `[print-awb][path] RESULT=full_pipeline orders=${order_sn_list.length} pipeline_ms=${Date.now() - fullPipelineStart} total_ms=${Date.now() - requestStart} fast_path_attempted=${fastPathAttempted}`
    );
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

// ===========================================================================
// >>> TEMPORARY PROBE — DELETE THIS ENTIRE BLOCK WHEN THE QUESTION IS ANSWERED
// ===========================================================================
//
// WHY THIS EXISTS
//   Before building the per-store pickup/dropoff preference, two facts have
//   to come from live Shopee data rather than assumption:
//     Q1. Does info_needed EVER name both pickup and dropoff for one order?
//         If it never does, the courier dictates the method and a per-store
//         "preference" would almost never apply.
//     Q2. Does dropoff.branch_list ever hold more than one branch, and does
//         any branch carry a preferred/nearest/default flag?
//         buildShipOrderBody() in api/_lib/shopeeShip.js currently takes
//         branch_list[0] unconditionally. If the list can be longer than 1
//         with no field to rank it by, "prefer dropoff" would be sending
//         parcels to an arbitrarily-chosen depot.
//
// WHAT IT DOES NOT DO
//   No ship_order call. No writes to any table. No change to auto-pack or to
//   the manual Pack button. get_shipping_parameter is a pure read.
//
// PRIVACY
//   get_shipping_parameter returns no buyer data at all — no recipient name,
//   address, or phone. pickup.address_list holds the SELLER OWN warehouse
//   addresses and dropoff.branch_list holds public courier depot locations,
//   so raw bodies are safe to echo back to the authenticated seller who owns
//   the shop. Even so, address_list is SUMMARISED (id + flags + slot count)
//   in the per-order summary rather than reprinted, since the questions above
//   only need its shape.
//
// HOW TO RUN
//   POST /api/shopee/print-awb?action=probe_shipping
//     Authorization: Bearer <supabase access token>
//     Content-Type: application/json
//     {}                              -> all of the caller Shopee stores
//     { "store_id": "<uuid>" }        -> just that one store
//
// HOW TO REMOVE
//   1. Delete this whole block (from the ">>> TEMPORARY PROBE" banner above
//      down to the "<<< END TEMPORARY PROBE" banner at the bottom), including
//      its own `import` line — nothing outside the block references it.
//   2. Delete the ">>> TEMPORARY PROBE BRANCH" block inside handler() above
//      (10 lines, immediately before the `const { store_id, order_sn_list,
//      print_all_unprinted }` destructure).
//   Nothing else in the file, and no other file, was touched.

import {
  buildSignedUrl as probeBuildSignedUrl,
  shopeeJsonCall as probeShopeeJsonCall,
} from '../_lib/shopeeAwb.js';

const PROBE_MAX_ORDERS = 5;
// Pulled newest-first, then narrowed to PROBE_MAX_ORDERS by courier spread.
// Bounded so the query can never hit the PostgREST 1000-row cap silently.
const PROBE_CANDIDATE_LIMIT = 200;
// Deliberately broad: the point is to DISCOVER whether a ranking field exists
// under any name, not to confirm one we already guessed.
const PROBE_FLAG_KEY_RE = /pref|near|default|recommend|primary|flag|select|main|sort|order|rank/i;

/** Union of keys across a list of objects — surfaces fields Shopee only sometimes sends. */
function probeUnionKeys(list) {
  return [...new Set(list.flatMap((item) => Object.keys(item ?? {})))];
}

/** Q1. Which methods info_needed actually names, and what today's code would pick. */
function probeInfoNeeded(infoNeeded) {
  if (!infoNeeded || typeof infoNeeded !== 'object') {
    return {
      present_keys: [],
      unexpected_keys: [],
      method_keys: [],
      method_count: 0,
      offers_both_pickup_and_dropoff: false,
      would_select_today: null,
    };
  }

  const presentKeys = Object.keys(infoNeeded);
  // selectShippingMethod() tests Array.isArray(), not mere presence — an
  // empty array is a valid selection. Mirror that exactly so
  // would_select_today is what the real code would do, not an approximation.
  const methodKeys = ['pickup', 'dropoff', 'non_integrated'].filter((key) =>
    Array.isArray(infoNeeded[key])
  );

  return {
    present_keys: presentKeys,
    // Any key that is NOT one of the three known methods — if Shopee has
    // added a fourth mode, selectShippingMethod() would fall through to its
    // "unrecognized shape" branch and this is where we would see it.
    unexpected_keys: presentKeys.filter(
      (key) => !['pickup', 'dropoff', 'non_integrated'].includes(key)
    ),
    method_keys: methodKeys,
    method_count: methodKeys.length,
    offers_both_pickup_and_dropoff:
      methodKeys.includes('pickup') && methodKeys.includes('dropoff'),
    // Replicates the fixed pickup -> dropoff -> non_integrated priority in
    // shopeeShip.js, so a "both offered" row also shows what is being
    // silently chosen today.
    would_select_today: methodKeys[0] ?? null,
  };
}

/** Q2. branch_list shape — length, and any field that could rank the branches. */
function probeBranchList(dropoff) {
  const list = Array.isArray(dropoff?.branch_list) ? dropoff.branch_list : null;
  if (!list) return { present: false, length: 0, keys: [], flag_like_keys: [], branches: [] };

  const keys = probeUnionKeys(list);
  return {
    present: true,
    length: list.length,
    keys,
    flag_like_keys: keys.filter((key) => PROBE_FLAG_KEY_RE.test(key)),
    // Verbatim: public courier depot records, and the whole question is
    // whether anything in them distinguishes one from another.
    branches: list,
  };
}

/** pickup.address_list shape — summarised, not reprinted (see PRIVACY above). */
function probeAddressList(pickup) {
  const list = Array.isArray(pickup?.address_list) ? pickup.address_list : null;
  if (!list) return { present: false, length: 0, keys: [], flag_like_keys: [], addresses: [] };

  const keys = probeUnionKeys(list);
  return {
    present: true,
    length: list.length,
    keys,
    flag_like_keys: keys.filter((key) => PROBE_FLAG_KEY_RE.test(key)),
    addresses: list.map((address) => ({
      address_id: address?.address_id ?? null,
      // selectPickupAddress() looks for 'pickup_address' in here and falls
      // back to [0]; this shows how often that flag is actually present.
      address_flag: address?.address_flag ?? null,
      time_slot_count: Array.isArray(address?.time_slot_list) ? address.time_slot_list.length : 0,
    })),
  };
}

/**
 * Up to PROBE_MAX_ORDERS orders spread across as many distinct couriers as
 * possible — round-robin over per-courier queues rather than taking the 5
 * newest, which on a busy shop would likely all share one courier and answer
 * nothing about whether the result varies by courier.
 */
function probePickOrders(orders) {
  const byCourier = new Map();
  for (const order of orders) {
    const key = order.courier_name ?? '(none)';
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(order);
  }

  const queues = [...byCourier.values()];
  const picked = [];

  for (let round = 0; picked.length < PROBE_MAX_ORDERS; round += 1) {
    let addedThisRound = false;
    for (const queue of queues) {
      if (round >= queue.length) continue;
      picked.push(queue[round]);
      addedThisRound = true;
      if (picked.length >= PROBE_MAX_ORDERS) break;
    }
    if (!addedThisRound) break;
  }

  return picked;
}

async function probeShippingParameters(user, storeIdFilter) {
  // Scoped to the caller own stores; store_id, when given, narrows within
  // that set rather than replacing the ownership filter.
  let storeQuery = supabaseAdmin
    .from('stores')
    .select('*')
    .eq('user_id', user.id)
    .eq('platform', 'shopee');

  if (storeIdFilter) storeQuery = storeQuery.eq('id', storeIdFilter);

  const { data: stores, error: storeError } = await storeQuery;

  if (storeError) {
    console.error('[probe-shipping] failed to load stores', storeError);
    return { httpStatus: 500, body: { success: false, error: 'Failed to load stores' } };
  }

  if (!stores || stores.length === 0) {
    return {
      httpStatus: 404,
      body: { success: false, error: 'No matching Shopee store found for this user' },
    };
  }

  const storesById = new Map(stores.map((store) => [store.id, store]));

  const { data: candidates, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('platform_order_id, courier_name, store_id')
    .in('store_id', [...storesById.keys()])
    .eq('order_status', 'READY_TO_SHIP')
    .order('order_created_at', { ascending: false })
    .limit(PROBE_CANDIDATE_LIMIT);

  if (orderError) {
    console.error('[probe-shipping] failed to load candidate orders', orderError);
    return { httpStatus: 500, body: { success: false, error: 'Failed to load candidate orders' } };
  }

  const selected = probePickOrders(candidates ?? []);

  console.log(
    `[probe-shipping] ${candidates?.length ?? 0} READY_TO_SHIP candidate(s) across ${stores.length} store(s); probing ${selected.length}`
  );

  const freshStoreCache = new Map();
  const results = [];

  for (const order of selected) {
    const orderSn = order.platform_order_id;
    const base = {
      order_sn: orderSn,
      store_id: order.store_id,
      courier_name: order.courier_name ?? null,
    };

    try {
      if (!freshStoreCache.has(order.store_id)) {
        freshStoreCache.set(order.store_id, await ensureFreshToken(storesById.get(order.store_id)));
      }
      const store = freshStoreCache.get(order.store_id);

      const url = probeBuildSignedUrl('/api/v2/logistics/get_shipping_parameter', store, {
        order_sn: orderSn,
      });
      // Logs the full raw body itself, so Vercel stdout carries the same
      // evidence as the HTTP response.
      const data = await probeShopeeJsonCall('get_shipping_parameter', url);
      const shippingParam = data.response ?? {};

      const infoNeeded = probeInfoNeeded(shippingParam.info_needed);
      const branchList = probeBranchList(shippingParam.dropoff);
      const addressList = probeAddressList(shippingParam.pickup);

      console.log(
        `[probe-shipping] ${orderSn} courier="${base.courier_name ?? '(none)'}" ` +
          `methods=[${infoNeeded.method_keys.join(',') || '(none)'}] both=${infoNeeded.offers_both_pickup_and_dropoff} ` +
          `branches=${branchList.length} addresses=${addressList.length}`
      );

      results.push({
        ...base,
        ok: true,
        info_needed_summary: infoNeeded,
        // Verbatim, as asked — the exact object the preference feature would
        // have to make its decision from.
        info_needed: shippingParam.info_needed ?? null,
        dropoff_branch_list: branchList,
        pickup_address_list: addressList,
        raw_response: data,
      });
    } catch (err) {
      console.error(`[probe-shipping] ${orderSn} failed:`, err.message);
      results.push({
        ...base,
        ok: false,
        error: err.message,
        shopee_response: err instanceof ShopeeStepError ? err.shopeeResponse : null,
      });
    }
  }

  const ok = results.filter((result) => result.ok);
  const couriersCovered = [...new Set(ok.map((result) => result.courier_name ?? '(none)'))];

  // The two questions, answered directly. `inconclusive` matters as much as
  // the answers: "no order offered both" across 2 orders on 1 courier is not
  // evidence of anything, and must not be read as a No.
  const answers = {
    q1_any_order_offers_both_pickup_and_dropoff: ok.some(
      (result) => result.info_needed_summary.offers_both_pickup_and_dropoff
    ),
    q1_method_key_combinations_seen: [
      ...new Set(ok.map((result) => result.info_needed_summary.method_keys.join('+') || '(none)')),
    ],
    q2_max_branch_list_length: ok.reduce(
      (max, result) => Math.max(max, result.dropoff_branch_list.length),
      0
    ),
    q2_any_branch_list_longer_than_one: ok.some((result) => result.dropoff_branch_list.length > 1),
    q2_branch_keys_seen: [...new Set(ok.flatMap((result) => result.dropoff_branch_list.keys))],
    q2_branch_flag_like_keys_seen: [
      ...new Set(ok.flatMap((result) => result.dropoff_branch_list.flag_like_keys)),
    ],
    couriers_covered: couriersCovered,
    inconclusive:
      ok.length < 2 || couriersCovered.length < 2
        ? 'Too few orders or too few distinct couriers to generalise — re-run when more READY_TO_SHIP orders exist across different couriers.'
        : null,
  };

  return {
    httpStatus: 200,
    body: {
      success: true,
      probe: 'get_shipping_parameter',
      temporary: true,
      note: 'Read-only probe. No ship_order call, no DB writes. No buyer data: pickup addresses are the seller own, branches are public courier depots.',
      stores_scanned: stores.length,
      candidates_found: candidates?.length ?? 0,
      probed: results.length,
      answers,
      results,
    },
  };
}

// ===========================================================================
// <<< END TEMPORARY PROBE
// ===========================================================================
