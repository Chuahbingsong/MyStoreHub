import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { withCors } from '../_lib/cors.js';
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

    // One local read serving both the fast-path gate and the tracking-number
    // cache below, so the fast path costs first-time prints nothing.
    const stateDone = perf.start('loadOrderPrintState');
    const { trackingByOrderSn: storedTracking, allPrinted } = await loadOrderPrintState(
      store.id,
      order_sn_list
    );
    stateDone();

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
