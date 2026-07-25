import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from '../_lib/shopee.js';
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { ensureFreshToken, shipOrder, ShopeeStepError } from '../_lib/shopeeShip.js';
import { logSyncStart, logSyncComplete, resyncOrder } from '../_lib/shopeeSync.js';

// Human-readable labels for the messages we surface to the seller after a
// buyer-cancellation decision — same vocabulary as the Orders page.
const STATUS_LABELS = {
  UNPAID: 'Unpaid',
  INVOICE_PENDING: 'Invoice Pending',
  READY_TO_SHIP: 'To Pack',
  PROCESSED: 'Processed',
  RETRY_SHIP: 'Retry Shipment',
  SHIPPED: 'Shipped',
  TO_CONFIRM_RECEIVE: 'To Confirm Receipt',
  COMPLETED: 'Completed',
  IN_CANCEL: 'Cancel Requested',
  CANCELLED: 'Cancelled',
  TO_RETURN: 'Return Requested',
};

function humanStatus(status) {
  return STATUS_LABELS[status] ?? status ?? 'updated';
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

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

async function cancelOrder(store, orderSn) {
  const path = '/api/v2/order/cancel_order';
  const url = buildSignedUrl(path, store);

  // Shopee requires a cancel_reason enum; OUT_OF_STOCK is the seller default.
  const body = {
    order_sn: orderSn,
    cancel_reason: 'OUT_OF_STOCK',
    item_list: [],
  };

  console.log('[order-action] cancelling order', orderSn);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[order-action] cancel_order failed', orderSn, data);
    throw new Error(data.message || `Failed to cancel order ${orderSn}`);
  }

  console.log('[order-action] order cancelled', orderSn);
  return data;
}

// Accept or reject a BUYER's cancellation request (Shopee's
// handle_buyer_cancellation — the order is currently IN_CANCEL awaiting the
// seller). operation is 'ACCEPT' or 'REJECT', the only two values Shopee
// takes. Throws a ShopeeStepError carrying Shopee's full response on any API
// error — that error is how we detect the "already resolved" race (Shopee
// rejects the call because the order left IN_CANCEL before we acted). The
// SUCCESS response body is deliberately NOT interpreted here: the caller
// verifies the outcome by re-syncing the order's real status instead.
async function handleBuyerCancellation(store, orderSn, operation) {
  const path = '/api/v2/order/handle_buyer_cancellation';
  const url = buildSignedUrl(path, store);
  const body = { order_sn: orderSn, operation };

  console.log('[order-action] handle_buyer_cancellation', operation, orderSn);

  let response;
  let bodyText;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    bodyText = await response.text();
  } catch (err) {
    throw new ShopeeStepError(
      'handle_buyer_cancellation',
      `Network error calling Shopee (handle_buyer_cancellation): ${err.message}`,
      null
    );
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { _unparsed_body: bodyText };
  }

  console.log(
    `[order-action] handle_buyer_cancellation ${operation} ${orderSn}: HTTP ${response.status}`,
    JSON.stringify(data)
  );

  if (!response.ok || data.error) {
    throw new ShopeeStepError(
      'handle_buyer_cancellation',
      data.message || `handle_buyer_cancellation ${operation} failed for ${orderSn}`,
      data
    );
  }

  return data;
}

// Runs the full accept/reject flow for a buyer cancellation: log to sync_logs,
// call Shopee, then VERIFY by re-syncing the order (never trust the action's
// response). Resolves the "already auto-approved / buyer withdrew" race
// gracefully. Writes its own HTTP response and returns nothing.
async function runBuyerCancellationAction(res, store, orderSn, action) {
  const operation = action === 'accept_buyer_cancel' ? 'ACCEPT' : 'REJECT';
  const logId = await logSyncStart(store.id, 'buyer_cancellation');

  try {
    // Attempt the action. A ShopeeStepError here is NOT treated as fatal yet —
    // it's frequently the "already resolved" signal, confirmed by the re-sync
    // below. Any non-Shopee error (a real bug) still propagates.
    let shopeeError = null;
    try {
      await handleBuyerCancellation(store, orderSn, operation);
    } catch (err) {
      if (!(err instanceof ShopeeStepError)) throw err;
      shopeeError = err;
    }

    // VERIFY, don't trust the response: the order's real status is the single
    // source of truth for what happened.
    const resync = await resyncOrder(store, orderSn);
    const status = resync.orderStatus;
    const stillPending = resync.found && status === 'IN_CANCEL';

    // Still IN_CANCEL after the call — the request genuinely wasn't applied.
    if (stillPending) {
      const message = shopeeError
        ? `Shopee rejected the ${operation === 'ACCEPT' ? 'approval' : 'rejection'}: ${shopeeError.message}`
        : 'Shopee still shows this order as awaiting your response — please try again in a moment.';
      await logSyncComplete(logId, 'error', `${operation} ${orderSn}: still IN_CANCEL — ${message}`);
      return res.status(502).json({
        success: false,
        action,
        order_sn: orderSn,
        step: 'handle_buyer_cancellation',
        error: message,
        order_status: status,
        shopee_response: shopeeError?.shopeeResponse ?? null,
      });
    }

    // No longer pending. Either our action applied, or it was already resolved
    // (auto-approved after 2 days / buyer withdrew) before we clicked — both
    // are success from the seller's side, just with different messaging.
    const alreadyResolved = Boolean(shopeeError);
    const label = humanStatus(status);
    const message = alreadyResolved
      ? `This cancellation was already resolved — the order is now ${label}.`
      : operation === 'ACCEPT'
        ? `Cancellation approved — the order is now ${label}.`
        : `Cancellation rejected — the order is back to ${label}.`;

    await logSyncComplete(
      logId,
      'success',
      `${operation} ${orderSn} -> ${status ?? 'unknown'}${alreadyResolved ? ' (already resolved before action)' : ''}`
    );

    return res.status(200).json({
      success: true,
      action,
      order_sn: orderSn,
      operation,
      order_status: status,
      already_resolved: alreadyResolved,
      message,
    });
  } catch (err) {
    // Unexpected failure (e.g. the re-sync itself threw) — log and surface.
    const shopeeResponse = err instanceof ShopeeStepError ? err.shopeeResponse : null;
    console.error(`[order-action] buyer-cancellation ${operation} failed for ${orderSn}:`, err.message);
    await logSyncComplete(logId, 'error', `${operation} ${orderSn}: ${err.message}`);
    return res.status(502).json({
      success: false,
      action,
      order_sn: orderSn,
      step: 'handle_buyer_cancellation',
      error: err.message,
      shopee_response: shopeeResponse,
    });
  }
}

async function updateOrderStatus(store, orderSn, patch) {
  const { error } = await supabaseAdmin
    .from('orders')
    .update(patch)
    .eq('store_id', store.id)
    .eq('platform_order_id', orderSn);

  if (error) {
    console.error('[order-action] failed to update order in Supabase', orderSn, error);
    // The Shopee action already succeeded; surface but don't fail the whole request.
  }
}

export default async function handler(req, res) {
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
    console.error('[order-action] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, order_sn, action } = req.body ?? {};

  if (!store_id) {
    return res.status(400).json({ success: false, error: 'store_id is required' });
  }

  if (!order_sn) {
    return res.status(400).json({ success: false, error: 'order_sn is required' });
  }

  const VALID_ACTIONS = ['ship', 'cancel', 'accept_buyer_cancel', 'reject_buyer_cancel'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({
      success: false,
      error: `action must be one of: ${VALID_ACTIONS.join(', ')}`,
    });
  }

  const { data: store, error: storeLookupError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('id', store_id)
    .eq('platform', 'shopee')
    .maybeSingle();

  if (storeLookupError) {
    console.error('[order-action] failed to load store', storeLookupError);
    return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
  }

  if (!store) {
    return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
  }

  if (store.user_id !== user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  try {
    const freshStore = await ensureFreshToken(store);

    console.log('[order-action] performing', action, 'on order', order_sn, 'store', store.id);

    if (action === 'accept_buyer_cancel' || action === 'reject_buyer_cancel') {
      // Writes its own response (success, already-resolved, or error) and
      // logs to sync_logs internally.
      return await runBuyerCancellationAction(res, freshStore, order_sn, action);
    }

    if (action === 'ship') {
      // allowIncomplete: true — a human is present here (manual Pack button),
      // so let Shopee's own validation be the final word on an incomplete
      // info_needed rather than refusing to try. Auto-pack does not do this.
      await shipOrder(freshStore, order_sn, { allowIncomplete: true });
      // ship_order arranges the shipment; Shopee moves the order to PROCESSED
      // ("seller is preparing the parcel"). It only becomes SHIPPED once the
      // courier collects, which the next sync picks up.
      await updateOrderStatus(freshStore, order_sn, {
        order_status: 'PROCESSED',
        packed_at: new Date().toISOString(),
        packed_by: 'manual',
      });
    } else {
      await cancelOrder(freshStore, order_sn);
      await updateOrderStatus(freshStore, order_sn, {
        order_status: 'CANCELLED',
      });
    }

    return res.status(200).json({ success: true, action, order_sn });
  } catch (err) {
    const step = err instanceof ShopeeStepError ? err.step : 'unknown';
    const shopeeResponse = err instanceof ShopeeStepError ? err.shopeeResponse : null;

    console.error(`[order-action] ${action} failed at step "${step}" for ${order_sn}:`, err.message);
    if (shopeeResponse) {
      console.error('[order-action] full Shopee response for failed step:');
      console.error(JSON.stringify(shopeeResponse, null, 2));
    } else {
      console.error(err);
    }

    return res.status(502).json({
      success: false,
      action,
      order_sn,
      step,
      error: err.message,
      shopee_response: shopeeResponse,
    });
  }
}
