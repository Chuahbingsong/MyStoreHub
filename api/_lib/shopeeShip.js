import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';

// Shared "arrange shipment" core, used by both api/shopee/order-action.js
// (manual Pack button, human present) and api/_lib/autoPack.js (unattended,
// cron-driven). Extracted so the two paths can never drift into two
// different implementations of the same Shopee call.

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

async function refreshShopeeToken(store) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp);

  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  console.log('[shopee-ship] refreshing token for store', store.id);

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
    console.error('[shopee-ship] token refresh failed', data);
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
    console.error('[shopee-ship] failed to save refreshed token', updateError);
    throw new Error('Failed to save refreshed Shopee token');
  }

  console.log('[shopee-ship] token refreshed for store', store.id);

  return {
    ...store,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: tokenExpiresAt,
  };
}

/**
 * Returns the store with a valid (refreshed if needed) access token.
 */
export async function ensureFreshToken(store) {
  const expiresAt = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
  if (expiresAt <= Date.now()) {
    return refreshShopeeToken(store);
  }
  return store;
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

/**
 * Carries the step and Shopee's full response body up to the caller so the
 * client (or auto-pack's sync_logs entry) gets the real reason instead of a
 * generic message.
 */
export class ShopeeStepError extends Error {
  constructor(step, message, shopeeResponse) {
    super(message);
    this.name = 'ShopeeStepError';
    this.step = step;
    this.shopeeResponse = shopeeResponse ?? null;
  }
}

/**
 * Thrown instead of calling ship_order at all when info_needed requires a
 * field Shopee's own get_shipping_parameter response can't supply (e.g. a
 * non_integrated channel's seller-provided tracking_number). A human using
 * the manual Pack button can still choose to send an incomplete body and let
 * Shopee be the final arbiter (see allowIncomplete) — auto-pack never does,
 * since there's no one present to notice a doomed call failed.
 */
export class IncompleteShippingInfoError extends Error {
  constructor(method, missing) {
    super(`Cannot auto-fill required field(s) for ${method}: ${missing.join(', ')}`);
    this.name = 'IncompleteShippingInfoError';
    this.method = method;
    this.missing = missing;
  }
}

/**
 * Thrown instead of auto-filling pickup_time_id (previously always
 * time_slot_list[0]) when info_needed resolves to 'pickup' and the caller
 * has not opted into best-effort defaults. Choosing a pickup slot is a call
 * a human should make, not a silent first-slot default — see
 * IncompleteShippingInfoError above for the identical reasoning applied to
 * missing fields. Gated on the same `allowIncomplete` flag: auto-pack
 * (allowIncomplete: false) never picks a slot on a seller's behalf; the
 * manual Pack button (allowIncomplete: true) keeps today's first-slot
 * default untouched.
 */
export class PickupRequiresManualError extends Error {
  constructor(orderSn) {
    super(`Order ${orderSn} requires choosing a pickup time slot — needs manual packing`);
    this.name = 'PickupRequiresManualError';
    this.orderSn = orderSn;
  }
}

async function shopeeJsonCall(step, url, init) {
  let response;
  let bodyText;

  try {
    response = await fetch(url, init);
    bodyText = await response.text();
  } catch (err) {
    console.error(`[shopee-ship] ${step}: network error`, err.message);
    throw new ShopeeStepError(step, `Network error calling Shopee (${step}): ${err.message}`, null);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { _unparsed_body: bodyText };
  }

  console.log(`[shopee-ship] ${step}: HTTP ${response.status} raw response:`);
  console.log(JSON.stringify(data, null, 2));

  if (!response.ok || data.error) {
    throw new ShopeeStepError(step, data.message || `Shopee call failed: ${step}`, data);
  }

  return data;
}

async function getShippingParameter(store, orderSn) {
  const path = '/api/v2/logistics/get_shipping_parameter';
  const url = buildSignedUrl(path, store, { order_sn: orderSn });

  console.log('[shopee-ship] getting shipping parameter for', orderSn);

  const data = await shopeeJsonCall('get_shipping_parameter', url);
  return data.response ?? {};
}

/**
 * Picks the shipping method from info_needed rather than from the presence of a
 * pickup/dropoff object: Shopee returns both objects regardless, and only
 * info_needed says which one this order's channel actually accepts. An empty
 * array is still a valid selection — it means "this method, no extra fields".
 */
function selectShippingMethod(shippingParam) {
  const infoNeeded = shippingParam.info_needed ?? {};

  if (Array.isArray(infoNeeded.pickup)) return { method: 'pickup', fields: infoNeeded.pickup };
  if (Array.isArray(infoNeeded.dropoff)) return { method: 'dropoff', fields: infoNeeded.dropoff };
  if (Array.isArray(infoNeeded.non_integrated)) {
    return { method: 'non_integrated', fields: infoNeeded.non_integrated };
  }

  return { method: null, fields: [] };
}

/** Shopee flags the address configured for pickup; fall back to the first one. */
function selectPickupAddress(shippingParam) {
  const addressList = shippingParam.pickup?.address_list ?? [];
  return (
    addressList.find((address) => (address.address_flag ?? []).includes('pickup_address')) ??
    addressList[0] ??
    null
  );
}

/**
 * Returns { body, method, missing } — `missing` lists any info_needed field
 * we could not fill from get_shipping_parameter alone. Building and
 * evaluating are kept separate from sending so a caller (auto-pack) can
 * decide not to send at all when something's missing.
 *
 * options.blockPickup: when true, a resolved method of 'pickup' throws
 * PickupRequiresManualError immediately — before selectPickupAddress or any
 * other auto-fill runs — instead of picking time_slot_list[0] on the
 * seller's behalf.
 */
function buildShipOrderBody(orderSn, shippingParam, { blockPickup = false } = {}) {
  const { method, fields } = selectShippingMethod(shippingParam);
  const body = { order_sn: orderSn };

  console.log(`[shopee-ship] info_needed selects method "${method ?? '(none)'}", fields: ${fields.join(', ') || '(none)'}`);

  if (method === 'pickup') {
    if (blockPickup) {
      console.log(`[shopee-ship] pickup blocked for ${orderSn} — needs manual packing (no auto-fill attempted)`);
      throw new PickupRequiresManualError(orderSn);
    }

    const address = selectPickupAddress(shippingParam);
    const timeSlot = address?.time_slot_list?.[0];

    body.pickup = {};
    if (address?.address_id !== undefined) body.pickup.address_id = address.address_id;
    if (timeSlot?.pickup_time_id !== undefined) body.pickup.pickup_time_id = timeSlot.pickup_time_id;

    console.log(
      `[shopee-ship] pickup: address_id=${address?.address_id ?? '(none)'} pickup_time_id=${timeSlot?.pickup_time_id ?? '(none)'} slot="${timeSlot?.time_text ?? ''}"`
    );

    const missing = fields.filter((field) => body.pickup[field] === undefined);
    return { body, method, missing };
  }

  if (method === 'dropoff') {
    const branch = shippingParam.dropoff?.branch_list?.[0];

    body.dropoff = {};
    if (branch?.branch_id !== undefined) body.dropoff.branch_id = branch.branch_id;

    console.log(`[shopee-ship] dropoff: branch_id=${branch?.branch_id ?? '(none)'}`);

    // sender_real_name / tracking_number are seller-supplied and not present
    // anywhere in get_shipping_parameter's response — we cannot fill them.
    const missing = fields.filter((field) => body.dropoff[field] === undefined);
    return { body, method, missing };
  }

  if (method === 'non_integrated') {
    body.non_integrated = {};
    console.log('[shopee-ship] non_integrated channel; sending order_sn only');
    // non_integrated's fields (tracking_number, etc.) are always seller-
    // supplied, never derivable from get_shipping_parameter.
    return { body, method, missing: fields };
  }

  // get_shipping_parameter returned no recognizable method at all — Shopee's
  // response was empty, malformed, or genuinely names none of pickup/dropoff/
  // non_integrated. This is exactly as "incomplete" as a missing seller-
  // supplied field: without a method, there is nothing well-formed to send.
  // Reporting it via `missing` (rather than an empty array) means auto-pack
  // (allowIncomplete: false) skips the order — auto_pack_status 'skipped',
  // not 'failed' — instead of sending a bare {order_sn} body and letting the
  // failure come back misclassified as a hard failure. The manual Pack
  // button (allowIncomplete: true) still sends it anyway and lets Shopee's
  // own validation be the final word, same as every other incomplete case.
  console.error('[shopee-ship] info_needed named no recognizable shipping method (pickup/dropoff/non_integrated) — treating as incomplete');
  return { body, method, missing: ['(unrecognized info_needed shape — no pickup/dropoff/non_integrated method)'] };
}

/**
 * Arranges shipment for one order (Shopee's ship_order — moves
 * READY_TO_SHIP -> PROCESSED, books logistics, generates the AWB). Does NOT
 * mean the parcel has been collected; SHIPPED only happens once the courier
 * picks it up, which the next order sync picks up on its own.
 *
 * options.allowIncomplete: when false (the default — auto-pack's case),
 * throws IncompleteShippingInfoError instead of calling Shopee at all if
 * info_needed requires a field we can't fill, and ALSO throws
 * PickupRequiresManualError instead of auto-filling a pickup time slot. When
 * true (the manual Pack button's case, a human is present), sends the
 * best-effort body anyway — including the time_slot_list[0] pickup default —
 * and lets Shopee's own validation be the final word, matching prior
 * behavior exactly. Both errors are gated on this one flag so a human using
 * the manual button never sees new behavior.
 *
 * Returns { data, method } — `method` is whichever of pickup/dropoff/
 * non_integrated info_needed selected (see selectShippingMethod), so callers
 * can persist it instead of it living only in the console.log lines above.
 */
export async function shipOrder(store, orderSn, { allowIncomplete = false } = {}) {
  const shippingParam = await getShippingParameter(store, orderSn);
  const { body, method, missing } = buildShipOrderBody(orderSn, shippingParam, {
    blockPickup: !allowIncomplete,
  });

  if (missing.length > 0) {
    console.error(`[shopee-ship] ${method ?? '(none)'} is missing required field(s): ${missing.join(', ')}`);
    if (!allowIncomplete) {
      throw new IncompleteShippingInfoError(method ?? '(none)', missing);
    }
  }

  const path = '/api/v2/logistics/ship_order';
  const url = buildSignedUrl(path, store);

  console.log('[shopee-ship] ship_order request payload:');
  console.log(JSON.stringify(body, null, 2));

  const data = await shopeeJsonCall('ship_order', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('[shopee-ship] shipment arranged for', orderSn);
  return { data, method };
}
