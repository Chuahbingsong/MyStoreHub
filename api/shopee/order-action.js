import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from '../_lib/shopee.js';
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { ensureFreshToken, shipOrder, ShopeeStepError } from '../_lib/shopeeShip.js';

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

  if (action !== 'ship' && action !== 'cancel') {
    return res.status(400).json({ success: false, error: 'action must be "ship" or "cancel"' });
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
