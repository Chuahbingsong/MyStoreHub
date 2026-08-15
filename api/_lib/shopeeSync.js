import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { selectAllPaged, warnIfAtCap } from './supabaseSelect.js';

// Shared Shopee sync core, reused by api/shopee/sync-orders.js,
// api/shopee/sync-products.js and api/cron/sync-all.js.

const ORDER_LIST_PAGE_SIZE = 50;
const ORDER_DETAIL_BATCH_SIZE = 50; // Shopee's max order_sn per get_order_detail call

// =============================================================================
// TEMP BACKFILL — buyer_message (added 2026-08-15, remove when done).
//
// Widens the order sync window and forces already-terminal orders to be
// re-fetched, so the regular sync (cron + foreground) backfills the new
// buyer_message column onto existing orders and lets the message_to_seller
// field-name mapping (see mapOrderToRow's raw-value log) be checked against
// real data instead of only new orders going forward.
//
// Only reaches orders whose Shopee-side update_time falls inside the
// widened window (see fetchOrderSnList's time_range_field: 'update_time') —
// an order that hasn't changed status in longer than that won't be re-listed
// no matter how wide the window is set here.
//
// TO REVERT: set this back to `false`. That alone restores both effects
// below (7-day window, normal terminal-skip) — nothing else needs to change.
// =============================================================================
const TEMP_BACKFILL_BUYER_MESSAGE = true;

// Default to a short window so a single sync stays under the Vercel timeout.
// Callers may override via { days }.
const DEFAULT_ORDER_TIME_RANGE_DAYS = TEMP_BACKFILL_BUYER_MESSAGE ? 14 : 7;
// Wall-clock budget for a sync call, replacing the old order-count cap. A
// count cap silently truncates however Shopee happens to order its results;
// a time budget instead keeps working — list pages, then detail batches —
// until we're actually close to the maxDuration wall, reporting `hasMore`
// for whatever didn't fit. Leaves ~15s of the 60s maxDuration as margin for
// the final response + in-flight writes. Callers that loop over multiple
// stores in one invocation (sync-orders.js, cron/sync-all.js) should compute
// ONE deadline per request and pass it to every syncStoreOrders() call, so
// the budget is shared across stores rather than granted fresh to each.
export const SYNC_TIME_BUDGET_MS = 45_000;
// Terminal Shopee order statuses: once reached, Shopee will never flip them
// back, so re-fetching full detail for an order already stored as one of
// these is wasted work. Deliberately narrow — IN_CANCEL is NOT terminal
// (still in flight) and must still be re-fetched.
const TERMINAL_ORDER_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

const PRODUCT_LIST_PAGE_SIZE = 50;
const PRODUCT_DETAIL_BATCH_SIZE = 50;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function logSync(storeId, syncType, status, message) {
  const { error } = await supabaseAdmin.from('sync_logs').insert({
    store_id: storeId,
    sync_type: syncType,
    status,
    message,
  });
  if (error) {
    console.error('[shopee-sync] failed to write sync_logs', error);
  }
}

// Written at the start of a sync, updated in place when it finishes. A row
// stuck at status 'started' with no matching completion is the signature of
// a hard timeout (Vercel kills the process before any of our own try/catch
// can run) — previously that produced ZERO log rows, making a silently
// stuck store indistinguishable from one that was never synced at all.
export async function logSyncStart(storeId, syncType) {
  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .insert({ store_id: storeId, sync_type: syncType, status: 'started' })
    .select('id')
    .single();

  if (error) {
    console.error('[shopee-sync] failed to write sync_logs start row', error);
    return null;
  }
  return data.id;
}

export async function logSyncComplete(logId, status, message) {
  // The start-row insert itself failed — nothing to update. logSync's own
  // insert failure is already console.error'd; don't compound it.
  if (!logId) return;

  const { error } = await supabaseAdmin
    .from('sync_logs')
    .update({ status, message })
    .eq('id', logId);

  if (error) {
    console.error('[shopee-sync] failed to update sync_logs completion row', logId, error);
  }
}

// A hard Vercel timeout kills the process before any of our own try/catch can
// run, so a 'started' row with no completion is indistinguishable from
// "still running" — that's exactly the signal logSyncStart exists to leave.
// This lock reuses that same signal: a 'started' row for this store+type
// younger than LOCK_TTL_MS means a sync is genuinely in flight (started by
// cron OR the foreground auto-sync — they share one lock keyed on store_id
// since they can target the same store at the same time), so skip.
//
// Once a row ages past the TTL it stops counting, full stop — a killed
// attempt can never lock a store out for longer than LOCK_TTL_MS, no matter
// how many stale 'started' corpses have piled up from repeated timeouts,
// because the lock check only looks at *how recent* the row is, never at how
// many exist. logSyncComplete flips a row's status in place, so a sync that
// actually finishes stops holding the lock the instant it completes — TTL
// expiry only matters for the crash/timeout case.
//
// TTL = 60s maxDuration (shared by every sync entrypoint: cron, sync-orders,
// sync-products) + 30s margin for response flush and clock skew. That's
// comfortably above the worst-case single attempt, and comfortably below the
// cron interval (2 min), so a timed-out attempt's corpse always expires
// before the next cron tick — it never chains into a permanent lock. It also
// means a *successful* foreground sync (well under 45s in practice) never
// trips the next 60s foreground tick's lock check, since its row is already
// flipped to 'success' by then; the TTL only ever blocks a tick that would
// otherwise race a genuinely still-running (or just-killed) attempt.
const LOCK_TTL_MS = 90_000;

export async function acquireSyncLock(storeId, syncType) {
  const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();

  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .select('id')
    .eq('store_id', storeId)
    .eq('sync_type', syncType)
    .eq('status', 'started')
    .gte('synced_at', cutoff)
    .limit(1);

  if (error) {
    console.error('[shopee-sync] failed to check sync lock, proceeding without one', error);
    return true; // fail open — a missed lock check is safer than blocking real syncs
  }

  return (data ?? []).length === 0;
}

async function refreshShopeeToken(store) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp);

  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  console.log('[shopee-sync] refreshing token for store', store.id);

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
    console.error('[shopee-sync] token refresh failed', data);
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
    console.error('[shopee-sync] failed to save refreshed token', updateError);
    throw new Error('Failed to save refreshed Shopee token');
  }

  console.log('[shopee-sync] token refreshed for store', store.id);

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

/* ---------------------------------- Orders --------------------------------- */

async function fetchOrderSnList(store, { days, deadline }) {
  const path = '/api/v2/order/get_order_list';
  const timeTo = nowUnix();
  const timeFrom = timeTo - days * 24 * 60 * 60;

  const orderSnList = [];
  let cursor = '';
  let more = true;

  // Stop paginating once we're out of budget; whatever's left is reported via
  // `hasMore` so the caller knows a follow-up sync is needed. Shopee returns
  // orders newest-first for update_time windows (verified against this
  // account's live data), so what we stop short of is the OLDEST tail of the
  // window, not the newest orders.
  while (more && Date.now() < deadline) {
    const timestamp = nowUnix();
    const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

    const params = new URLSearchParams({
      partner_id: SHOPEE_PARTNER_ID,
      timestamp: String(timestamp),
      access_token: store.access_token,
      shop_id: store.shop_id,
      sign,
      // update_time (not create_time): an order whose status changes days
      // after it was placed — paid, packed, shipped, returned — must stay
      // inside this rolling window so the next sync still picks it up.
      // update_time is bumped at creation too, so nothing newly-placed is lost.
      time_range_field: 'update_time',
      time_from: String(timeFrom),
      time_to: String(timeTo),
      page_size: String(ORDER_LIST_PAGE_SIZE),
      response_optional_fields: 'order_status',
      cursor,
    });

    const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
    console.log('[shopee-sync] fetching order list, cursor:', cursor || '(start)');

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      console.error('[shopee-sync] get_order_list failed', data);
      throw new Error(data.message || 'Failed to fetch Shopee order list');
    }

    const orderList = data.response?.order_list ?? [];
    orderSnList.push(...orderList.map((o) => o.order_sn));

    more = Boolean(data.response?.more);
    cursor = data.response?.next_cursor ?? '';

    if (!cursor) {
      more = false;
    }
  }

  // If the loop exited because `more` naturally went false, we've listed the
  // whole window. If it exited because the deadline hit while `more` was
  // still true, there's a real tail left — hasMore is just `more` itself.
  console.log('[shopee-sync] total order_sn fetched:', orderSnList.length, 'hasMore:', more);
  return { orderSnList, hasMore: more };
}

async function fetchOrderDetails(store, orderSnBatch) {
  const path = '/api/v2/order/get_order_detail';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: store.shop_id,
    sign,
    order_sn_list: orderSnBatch.join(','),
    // buyer_cancel_reason/cancel_by/cancel_reason drive the buyer-cancellation
    // surface: an IN_CANCEL order needs the buyer's reason shown so the seller
    // can decide. cancel_by distinguishes a buyer-initiated request (the case
    // we act on) from a seller cancel.
    //
    // message_to_seller is the buyer's own checkout note (distinct from
    // Shopee's `note`/`note_update_time`, which is the SELLER's own
    // free-text note on the order — not what we want here). Field name
    // confirmed against third-party Shopee Open API v2 SDKs (not Shopee's
    // own docs directly, which weren't reachable from here) — mapOrderToRow
    // below logs the raw value on every sync so the mapping stays verifiable
    // against real orders instead of resting on that alone.
    response_optional_fields:
      'buyer_username,recipient_address,item_list,total_amount,order_status,create_time,pay_time,payment_method,shipping_carrier,package_list,buyer_cancel_reason,cancel_by,cancel_reason,message_to_seller',
  });

  const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
  console.log('[shopee-sync] fetching order details for', orderSnBatch.length, 'orders');

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[shopee-sync] get_order_detail failed', data);
    throw new Error(data.message || 'Failed to fetch Shopee order details');
  }

  const orderList = data.response?.order_list ?? [];

  // A nominally-successful response covering fewer orders than requested is
  // silent data loss otherwise: the missing orders just don't get written
  // this cycle, with nothing in the logs to say so. Not fatal on its own —
  // a non-terminal order gets re-requested next sync — but worth a visible
  // warning rather than an invisible gap.
  if (orderList.length !== orderSnBatch.length) {
    const returnedSns = new Set(orderList.map((o) => o.order_sn));
    const missing = orderSnBatch.filter((sn) => !returnedSns.has(sn));
    console.warn(
      `[shopee-sync] get_order_detail returned ${orderList.length}/${orderSnBatch.length} requested order(s) — missing: ${missing.join(', ') || '(unable to determine)'}`
    );
  }

  return orderList;
}

function mapOrderToRow(storeId, shopeeOrder) {
  const recipientAddress = shopeeOrder.recipient_address ?? {};

  // Logged unconditionally (not just when truthy) so an empty/missing value
  // is just as verifiable as a populated one while the message_to_seller
  // field-name mapping above is unconfirmed against Shopee's own docs.
  console.log(
    `[shopee-sync] raw message_to_seller for ${shopeeOrder.order_sn}:`,
    JSON.stringify(shopeeOrder.message_to_seller ?? null)
  );

  return {
    store_id: storeId,
    platform: 'shopee',
    platform_order_id: shopeeOrder.order_sn,
    order_status: shopeeOrder.order_status,
    buyer_name: shopeeOrder.buyer_username ?? null,
    shipping_address: recipientAddress.full_address ?? null,
    region: recipientAddress.state ?? null,
    total_amount: shopeeOrder.total_amount ?? null,
    currency: 'MYR',
    payment_method: shopeeOrder.payment_method ?? null,
    courier_name: shopeeOrder.shipping_carrier ?? null,
    // Populated only for orders in/through the cancellation flow; null
    // otherwise. buyer_cancel_reason is what the seller reads before deciding
    // approve/reject on an IN_CANCEL order.
    buyer_cancel_reason: shopeeOrder.buyer_cancel_reason ?? null,
    cancel_by: shopeeOrder.cancel_by ?? null,
    cancel_reason: shopeeOrder.cancel_reason ?? null,
    // The buyer's own checkout note — see response_optional_fields comment
    // above for why this is message_to_seller and not `note`.
    buyer_message: shopeeOrder.message_to_seller ?? null,
    // Free from get_order_detail's package_list (requested via
    // response_optional_fields above) — unlike tracking_number, no extra API
    // call needed. An order can in principle have multiple packages (split
    // shipment); only the first is stored, matching how a single AWB scan
    // maps to a single package in the common case.
    package_number: shopeeOrder.package_list?.[0]?.package_number ?? null,
    order_created_at: shopeeOrder.create_time
      ? new Date(shopeeOrder.create_time * 1000).toISOString()
      : null,
    paid_at: shopeeOrder.pay_time ? new Date(shopeeOrder.pay_time * 1000).toISOString() : null,
    synced_at: new Date().toISOString(),
  };
}

// Shopee returns the item/model image under image_info.image_url; some
// responses instead expose a flat image_url. Prefer whichever is present.
function itemImageFromOrder(item) {
  return item.image_info?.image_url ?? item.image_url ?? null;
}

// Builds a lookup of product images for a store so we can fall back to the
// synced product catalogue when an order item has no image of its own.
async function loadProductImageMap(storeId) {
  const byItemId = new Map();
  const bySku = new Map();

  // Paged: a store with >1000 products would otherwise silently lose the image
  // fallback for everything past the cap, showing imageless order items with no
  // error anywhere.
  const { data, error } = await selectAllPaged(`products.imageMap[${storeId}]`, (from, to) =>
    supabaseAdmin
      .from('products')
      .select('platform_product_id, sku, image_url')
      .eq('store_id', storeId)
      .range(from, to)
  );

  if (error) {
    console.error('[shopee-sync] failed to load product images for fallback', error);
    return { byItemId, bySku };
  }

  for (const product of data ?? []) {
    if (!product.image_url) continue;
    if (product.platform_product_id != null) {
      byItemId.set(String(product.platform_product_id), product.image_url);
    }
    if (product.sku) {
      bySku.set(product.sku, product.image_url);
    }
  }

  return { byItemId, bySku };
}

function mapItemsToRows(orderId, shopeeOrder, productImages) {
  const itemList = shopeeOrder.item_list ?? [];
  return itemList.map((item) => {
    // Fall back to the matching product's image (by item_id, then SKU) when the
    // order detail doesn't carry one.
    const fallbackImage =
      productImages.byItemId.get(String(item.item_id)) ??
      (item.item_sku ? productImages.bySku.get(item.item_sku) : undefined) ??
      null;

    return {
      order_id: orderId,
      product_name: item.item_name ?? null,
      variant_name: item.model_name ?? null,
      sku: item.item_sku ?? null,
      quantity: item.model_quantity_purchased ?? null,
      price: item.model_discounted_price ?? null,
      image_url: itemImageFromOrder(item) ?? fallbackImage,
    };
  });
}

// Orders already terminal (COMPLETED/CANCELLED) in our DB never change on
// Shopee's side again, so skip the get_order_detail round-trip (and the
// writes that would follow it) for them entirely — UNLESS the order has zero
// order_items rows. A terminal order with no items is exactly the shape left
// behind by the order_items concurrency bug (see replace_order_items): if we
// skipped those too, they'd stay itemless forever, since nothing else in a
// routine sync ever revisits a terminal order. Requiring at least one item
// row makes terminal-skip self-healing instead of a permanent hiding place
// for that bug (or any future one shaped like it).
async function fetchTerminalOrderSns(storeId, orderSnList) {
  // TEMP BACKFILL (see flag above): terminal orders are exactly the
  // historical orders this backfill needs to re-fetch, so none get skipped
  // while it's active. Revert removes this early return along with the flag.
  if (TEMP_BACKFILL_BUYER_MESSAGE) return new Set();

  if (orderSnList.length === 0) return new Set();

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('platform_order_id, order_status, order_items(count)')
    .eq('store_id', storeId)
    .in('platform_order_id', orderSnList);

  if (error) {
    console.error('[shopee-sync] failed to check existing statuses for terminal-skip, fetching all', error);
    return new Set(); // fail open — skip nothing rather than risk skipping something live
  }

  // Bounded by orderSnList (one sync window), so the cap should be
  // unreachable — but if a window ever exceeds it, truncation means terminal
  // orders go unrecognised and get needlessly re-fetched from Shopee. That
  // fails safe (wasted budget, never wrong data), so warn rather than page.
  warnIfAtCap(`orders.terminalSkip[${storeId}]`, data);

  return new Set(
    (data ?? [])
      .filter(
        (row) => TERMINAL_ORDER_STATUSES.has(row.order_status) && (row.order_items?.[0]?.count ?? 0) > 0
      )
      .map((row) => row.platform_order_id)
  );
}

// Existing order_items row counts for a set of order ids, keyed by order id.
// Used only to decide whether an empty incoming item_list is safe to write
// (order genuinely has none yet) or would wipe real data (see
// writeOrderItemsBatch below). A query failure returns -1 for every
// requested id — a sentinel meaning "unknown, assume nonzero" — so the
// caller fails safe (skips the write) rather than risking a wipe it couldn't
// actually verify.
async function existingItemCounts(orderIds) {
  if (orderIds.length === 0) return new Map();

  // PAGED, not a bare select. This returns one row per order_item, so a batch
  // of orders averaging >20 items each would hit PostgREST's silent 1000-row
  // cap. A truncated result makes an order look like it has ZERO items, which
  // flips the guard below from "skip, this would wipe real data" to "safe,
  // proceed" — the exact wipe this function exists to prevent. Paging removes
  // that failure mode entirely; hitting the ceiling degrades to the same -1
  // "couldn't verify" sentinel as an outright query error.
  const { data, error, truncated } = await selectAllPaged('order_items.existingItemCounts', (from, to) =>
    supabaseAdmin.from('order_items').select('order_id').in('order_id', orderIds).range(from, to)
  );

  if (error || truncated) {
    console.error(
      '[shopee-sync] failed to check existing item counts before an empty item_list write — skipping all affected orders this cycle to be safe',
      orderIds,
      error ?? 'result truncated at the paging ceiling'
    );
    return new Map(orderIds.map((id) => [id, -1]));
  }

  const counts = new Map();
  for (const row of data ?? []) {
    counts.set(row.order_id, (counts.get(row.order_id) ?? 0) + 1);
  }
  return counts;
}

// Rewrites order_items for a batch of orders via the replace_order_items
// Postgres function (see supabase/schema.sql), which deletes the old rows
// and inserts the fresh ones inside a single transaction. This used to be two
// separate client calls — insert the fresh rows, then delete the old ones
// excluding whatever this call just inserted — which was NOT safe under
// concurrent writers: two overlapping syncs for the same order (e.g. cron and
// a foreground auto-sync tick) could each insert their own fresh rows and
// then each delete the OTHER call's rows (since "exclude what I inserted"
// only ever knows about its own insert), leaving the order with zero items.
// Doing delete-then-insert atomically removes that window: concurrent calls
// serialize on Postgres's row lock for the delete, and whichever commits last
// simply leaves its own full, fresh set — never an empty one.
//
// A SEPARATE hazard: Shopee's get_order_detail response for one order in a
// batch can come back with item_list missing/empty due to a transient
// glitch, not because the order genuinely has no items — same shape as the
// concurrency bug above, different cause. Since replace_order_items deletes
// on order_id membership alone, blindly including such an order in
// p_order_ids would wipe its real item rows down to zero. orderSnByOrderId
// is optional and used only to make that warning log readable (falls back
// to the raw id when a caller doesn't have the mapping handy).
async function writeOrderItemsBatch(itemRowsByOrderId, orderSnByOrderId = new Map()) {
  const allOrderIds = [...itemRowsByOrderId.keys()];
  if (allOrderIds.length === 0) return;

  const emptyIncomingOrderIds = allOrderIds.filter(
    (orderId) => (itemRowsByOrderId.get(orderId) ?? []).length === 0
  );

  const skipOrderIds = new Set();

  if (emptyIncomingOrderIds.length > 0) {
    const existingCounts = await existingItemCounts(emptyIncomingOrderIds);

    for (const orderId of emptyIncomingOrderIds) {
      const previousCount = existingCounts.get(orderId) ?? 0;
      // previousCount === 0 means genuinely itemless (new order, or already
      // empty) — safe to let the no-op delete-nothing/insert-nothing below
      // proceed for it. Anything else (a real previous count, or -1 for
      // "couldn't verify") means this row must NOT be touched this cycle.
      if (previousCount !== 0) {
        skipOrderIds.add(orderId);
        const label = orderSnByOrderId.get(orderId) ?? orderId;
        const countLabel = previousCount === -1 ? 'unknown (count query failed)' : previousCount;
        console.error(
          `[shopee-sync] order ${label} returned an empty item_list but previously had ${countLabel} item row(s) — skipping the item write for this order this cycle instead of wiping it; will retry next sync`
        );
      }
    }
  }

  const orderIds = allOrderIds.filter((orderId) => !skipOrderIds.has(orderId));
  if (orderIds.length === 0) return;

  const itemRows = orderIds.flatMap((orderId) => itemRowsByOrderId.get(orderId));

  const { error } = await supabaseAdmin.rpc('replace_order_items', {
    p_order_ids: orderIds,
    p_items: itemRows,
  });

  if (error) {
    console.error(
      '[shopee-sync] replace_order_items RPC failed — orders keep their previous items until next sync',
      orderIds,
      error
    );
  }
}

// Per-order fallback path — identical to the original one-row-at-a-time
// logic, including per-order error logging. Used only when the fast batched
// upsert below fails outright, so one malformed row in a batch can't sink
// every other order in it.
async function writeOrdersOneByOne(storeId, shopeeOrders, productImages) {
  const savedOrders = [];

  for (const shopeeOrder of shopeeOrders) {
    const orderRow = mapOrderToRow(storeId, shopeeOrder);

    const { data: savedOrder, error: upsertError } = await supabaseAdmin
      .from('orders')
      .upsert(orderRow, { onConflict: 'store_id,platform_order_id' })
      .select()
      .single();

    if (upsertError) {
      console.error('[shopee-sync] failed to upsert order', shopeeOrder.order_sn, upsertError);
      continue;
    }

    const itemRows = mapItemsToRows(savedOrder.id, shopeeOrder, productImages);
    await writeOrderItemsBatch(
      new Map([[savedOrder.id, itemRows]]),
      new Map([[savedOrder.id, shopeeOrder.order_sn]])
    );

    savedOrders.push(savedOrder);
  }

  return savedOrders;
}

// Writes one get_order_detail batch (up to 50 orders) in as few round-trips
// as possible: one multi-row upsert for `orders`, then one delete + one
// insert covering `order_items` for the whole batch, instead of 3 sequential
// calls PER order. This is what actually keeps a sync inside the time
// budget — a store with 50+ orders needing full writes was previously
// making up to 150 sequential Supabase calls in a single request.
async function writeOrderBatch(storeId, shopeeOrders, productImages) {
  const orderRows = shopeeOrders.map((o) => mapOrderToRow(storeId, o));

  const { data: savedOrders, error: upsertError } = await supabaseAdmin
    .from('orders')
    .upsert(orderRows, { onConflict: 'store_id,platform_order_id' })
    .select('id, platform_order_id');

  if (upsertError) {
    // A single bad row can fail an entire multi-row upsert statement (no
    // partial commit within one call) — fall back to the slower but
    // resilient per-order path so the other orders in this batch still land.
    console.error(
      '[shopee-sync] batch upsert failed, falling back to per-order upserts for this batch',
      shopeeOrders.map((o) => o.order_sn),
      upsertError
    );
    return writeOrdersOneByOne(storeId, shopeeOrders, productImages);
  }

  const savedIdByOrderSn = new Map(savedOrders.map((o) => [o.platform_order_id, o.id]));
  const orderSnByOrderId = new Map(savedOrders.map((o) => [o.id, o.platform_order_id]));
  const itemRowsByOrderId = new Map();

  for (const shopeeOrder of shopeeOrders) {
    const orderId = savedIdByOrderSn.get(shopeeOrder.order_sn);
    if (!orderId) continue; // shouldn't happen — upsert didn't error, so every row should be present
    itemRowsByOrderId.set(orderId, mapItemsToRows(orderId, shopeeOrder, productImages));
  }

  await writeOrderItemsBatch(itemRowsByOrderId, orderSnByOrderId);

  return savedOrders;
}

// Shopee order_status values an order can hold before a courier label (and
// therefore a tracking number) could possibly exist. Calling
// get_tracking_number for orders still in one of these is a guaranteed-empty
// round trip, so they're excluded from backfill candidates up front.
const NOT_YET_SHIPPABLE_STATUSES = ['UNPAID', 'INVOICE_PENDING', 'READY_TO_SHIP'];

// Shopee order_status values where a courier AWB was never generated (or, for
// TO_RETURN, isn't retrievable via this call) and never will be — calling
// get_tracking_number for these is a guaranteed-empty round trip forever, not
// just until shipping happens. Without this exclusion these permanently
// camp in the fixed-size candidate page (no ORDER BY guarantees eviction)
// and starve every fillable order behind them:
//   - CANCELLED: order cancelled, no label was ever created for it.
//   - IN_CANCEL: cancellation in progress. Not in TERMINAL_ORDER_STATUSES
//     above (it can still flip back), but the same "no label" logic applies
//     for backfill purposes regardless of how it resolves.
//   - TO_RETURN: buyer-initiated return/refund flow. Observed in prod data
//     with tracking_number still null — treated as unfillable rather than
//     risking another permanent-camp candidate.
const TRACKING_NEVER_AVAILABLE_STATUSES = ['CANCELLED', 'IN_CANCEL', 'TO_RETURN'];

const TRACKING_BACKFILL_EXCLUDED_STATUSES = [
  ...NOT_YET_SHIPPABLE_STATUSES,
  ...TRACKING_NEVER_AVAILABLE_STATUSES,
];

// A get_tracking_number call that succeeds but comes back empty (order is in
// an eligible status yet Shopee still has no AWB on file — e.g. self-arranged
// pickup, or a data lag) must not be retried every single cron cycle forever;
// that's the same camping failure mode as an excluded status, just per-row
// instead of per-status. tracking_backfill_attempted_at + this cooldown gate
// that row out of the candidate query until it's worth trying again, while
// still allowing a legitimate later retry (unlike a permanent terminal flag).
const TRACKING_BACKFILL_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// No longer deadline-scaled-down-to-almost-nothing: with the status filter
// above keeping unfillable rows out of the candidate page, and the cooldown
// keeping empty-result rows from re-camping, raising this is safe — no
// error_auth/throttling has been observed on get_tracking_number. Still
// bounded by the shared `deadline` param below, so a slow store can't blow
// its time budget.
const TRACKING_BACKFILL_CAP_PER_STORE = 30;

async function getTrackingNumberForBackfill(store, orderSn) {
  const path = '/api/v2/logistics/get_tracking_number';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: store.shop_id,
    sign,
    order_sn: orderSn,
  });

  const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    // Logged with a distinct, greppable prefix so throttling shows up clearly
    // in sync_logs/Vercel logs: watch for error_auth or anything mentioning
    // rate limits here after this ships.
    console.error(`[shopee-sync] [backfill-tracking] get_tracking_number failed for ${orderSn}:`, data);
    return null;
  }

  return data.response?.tracking_number || null;
}

/**
 * Fills in tracking_number for this store's orders that don't have one yet —
 * covers orders whose AWB was printed via Shopee/BigSeller/etc rather than
 * through this app (print-awb.js only ever sets tracking_number for labels it
 * prints itself). Capped at TRACKING_BACKFILL_CAP_PER_STORE per call and
 * bounded by the same shared `deadline` as the rest of the sync, so a large
 * historical backlog clears gradually across many sync runs instead of
 * risking a timeout or rate-limit hit in any single one.
 */
async function backfillTrackingNumbers(store, deadline) {
  const retryCooldownCutoff = new Date(Date.now() - TRACKING_BACKFILL_RETRY_COOLDOWN_MS).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('orders')
    .select('id, platform_order_id')
    .eq('store_id', store.id)
    .is('tracking_number', null)
    .not('order_status', 'in', `(${TRACKING_BACKFILL_EXCLUDED_STATUSES.join(',')})`)
    .or(`tracking_backfill_attempted_at.is.null,tracking_backfill_attempted_at.lt.${retryCooldownCutoff}`)
    .order('order_created_at', { ascending: false })
    .limit(TRACKING_BACKFILL_CAP_PER_STORE);

  if (error) {
    console.error('[shopee-sync] [backfill-tracking] failed to load candidates', error);
    return { attempted: 0, filled: 0 };
  }

  if (!candidates || candidates.length === 0) {
    return { attempted: 0, filled: 0 };
  }

  console.log(
    `[shopee-sync] [backfill-tracking] [${store.id}] ${candidates.length} candidate(s) missing tracking_number (cap ${TRACKING_BACKFILL_CAP_PER_STORE})`,
  );

  let attempted = 0;
  let filled = 0;

  for (const order of candidates) {
    if (Date.now() >= deadline) {
      console.log(
        `[shopee-sync] [backfill-tracking] [${store.id}] time budget reached, stopping after ${attempted}/${candidates.length}`,
      );
      break;
    }

    attempted += 1;
    const trackingNumber = await getTrackingNumberForBackfill(store, order.platform_order_id);

    if (!trackingNumber) {
      // Eligible status, but Shopee still has nothing on file — stamp it so
      // this row drops out of the candidate page until the cooldown passes,
      // instead of re-camping the cap every cycle.
      const { error: stampError } = await supabaseAdmin
        .from('orders')
        .update({ tracking_backfill_attempted_at: new Date().toISOString() })
        .eq('id', order.id);
      if (stampError) {
        console.error(
          `[shopee-sync] [backfill-tracking] failed to stamp attempted_at for ${order.platform_order_id}`,
          stampError,
        );
      }
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update({ tracking_number: trackingNumber })
      .eq('id', order.id);

    if (updateError) {
      console.error(
        `[shopee-sync] [backfill-tracking] failed to save tracking_number for ${order.platform_order_id}`,
        updateError,
      );
      continue;
    }

    filled += 1;
  }

  console.log(
    `[shopee-sync] [backfill-tracking] [${store.id}] done: ${filled}/${attempted} filled`,
  );

  return { attempted, filled };
}

/**
 * Syncs a single store's recent orders (and their line items) into Supabase.
 * Expects a store row; refreshes the token internally if needed.
 *
 * options.deadline: absolute Date.now()-comparable timestamp this call must
 * stop starting new work by. Callers looping over multiple stores in one
 * invocation (sync-orders.js, cron/sync-all.js) should compute ONE deadline
 * per request and pass the same value into every call, so the budget is
 * shared across stores instead of granted fresh to each. Defaults to a fresh
 * SYNC_TIME_BUDGET_MS window for standalone callers.
 */
export async function syncStoreOrders(store, options = {}) {
  const days = options.days ?? DEFAULT_ORDER_TIME_RANGE_DAYS;
  const deadline = options.deadline ?? Date.now() + SYNC_TIME_BUDGET_MS;

  const canProceed = await acquireSyncLock(store.id, 'orders');
  if (!canProceed) {
    console.log(`[shopee-sync] [${store.id}] orders sync already in progress elsewhere, skipping`);
    return { storeId: store.id, orders: [], synced: 0, hasMore: false, locked: true };
  }

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const logId = await logSyncStart(store.id, 'orders');

  try {
    const freshStore = await ensureFreshToken(store);
    console.log(`[shopee-sync] [${store.id}] token ready at ${elapsed()}`);

    const { orderSnList, hasMore: listHasMore } = await fetchOrderSnList(freshStore, { days, deadline });
    console.log(
      `[shopee-sync] [${store.id}] fetched ${orderSnList.length} order_sn (last ${days}d) at ${elapsed()}, listHasMore=${listHasMore}`,
    );

    if (orderSnList.length === 0) {
      await logSyncComplete(logId, 'success', 'No orders found in range');
      return { storeId: store.id, orders: [], synced: 0, hasMore: listHasMore };
    }

    const terminalSns = await fetchTerminalOrderSns(store.id, orderSnList);
    const toFetch = orderSnList.filter((sn) => !terminalSns.has(sn));
    console.log(
      `[shopee-sync] [${store.id}] ${terminalSns.size} already terminal (skipped), ${toFetch.length} to fetch at ${elapsed()}`,
    );

    // Loaded once per sync for the order-item image fallback.
    const productImages = await loadProductImageMap(store.id);

    const batches = chunk(toFetch, ORDER_DETAIL_BATCH_SIZE);
    const savedOrders = [];
    let batchesProcessed = 0;

    for (const batch of batches) {
      if (Date.now() >= deadline) {
        console.log(`[shopee-sync] [${store.id}] time budget reached at ${elapsed()}, stopping before batch ${batchesProcessed + 1}/${batches.length}`);
        break;
      }

      const shopeeOrders = await fetchOrderDetails(freshStore, batch);
      const saved = await writeOrderBatch(store.id, shopeeOrders, productImages);
      savedOrders.push(...saved);
      batchesProcessed += 1;

      // Progress is persisted incrementally (each batch written above), so
      // even if we run out of budget on a later batch, work done so far stays.
      console.log(
        `[shopee-sync] [${store.id}] batch ${batchesProcessed}/${batches.length} written, ${savedOrders.length} orders saved so far at ${elapsed()}`,
      );
    }

    const detailHasMore = batchesProcessed < batches.length;
    const hasMore = listHasMore || detailHasMore;

    // TEMP BACKFILL (see flag near the top of this file): logged distinctly
    // and folded into the persisted sync_logs summary below (not just
    // console output, which Vercel rolls off) so how many orders got
    // re-synced under the widened window is checkable after the fact.
    if (TEMP_BACKFILL_BUYER_MESSAGE) {
      console.log(
        `[shopee-sync] [TEMP BACKFILL] [${store.id}] re-synced ${savedOrders.length} order(s) in the widened ${days}-day window (terminal-skip bypassed)`,
      );
    }

    await supabaseAdmin
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', store.id);

    // Runs last, after the deadline-bound order work above, so it only ever
    // spends whatever time budget is left over — see backfillTrackingNumbers.
    const backfill = await backfillTrackingNumbers(freshStore, deadline);
    console.log(
      `[shopee-sync] [${store.id}] tracking backfill: ${backfill.filled}/${backfill.attempted} filled at ${elapsed()}`,
    );

    const backfillTag = TEMP_BACKFILL_BUYER_MESSAGE ? ` [TEMP BACKFILL: ${savedOrders.length} re-synced, ${days}d window]` : '';
    const summary = `Synced ${savedOrders.length} orders (${terminalSns.size} already-terminal skipped)${hasMore ? ', more pending' : ''}, tracking backfill ${backfill.filled}/${backfill.attempted} in ${Date.now() - t0}ms${backfillTag}`;
    await logSyncComplete(logId, 'success', summary);

    console.log(
      `[shopee-sync] [${store.id}] done: synced ${savedOrders.length} orders in ${elapsed()}, hasMore=${hasMore}`,
    );

    return { storeId: store.id, orders: savedOrders, synced: savedOrders.length, hasMore };
  } catch (err) {
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}

/**
 * Re-fetches ONE order's live detail from Shopee and writes it, returning its
 * real current status. This is the "verify, don't trust the response"
 * primitive for state-changing order actions (mirrors autoBoost's
 * get_boosted_list re-poll): after an action like handle_buyer_cancellation —
 * whose own response body is undocumented and therefore never trusted — the
 * caller re-syncs and reads order_status here to decide what actually
 * happened, rather than parsing the action's response.
 *
 * Returns { found, orderStatus, buyerCancelReason, cancelBy, cancelReason }.
 * found=false means Shopee returned no detail for this order_sn.
 */
export async function resyncOrder(store, orderSn) {
  const freshStore = await ensureFreshToken(store);
  const orders = await fetchOrderDetails(freshStore, [orderSn]);

  if (orders.length === 0) {
    return { found: false, orderStatus: null };
  }

  const productImages = await loadProductImageMap(store.id);
  await writeOrderBatch(store.id, orders, productImages);

  const o = orders[0];
  return {
    found: true,
    orderStatus: o.order_status ?? null,
    buyerCancelReason: o.buyer_cancel_reason ?? null,
    cancelBy: o.cancel_by ?? null,
    cancelReason: o.cancel_reason ?? null,
  };
}

/* --------------------------------- Products -------------------------------- */

// Stops paginating once the deadline is hit, same shape as fetchOrderSnList —
// a store with a very large catalogue must not be able to list forever with
// no time check, which was the previous behavior.
async function fetchItemIdList(store, { deadline }) {
  const path = '/api/v2/product/get_item_list';

  const itemIdList = [];
  let offset = 0;
  let more = true;

  while (more && Date.now() < deadline) {
    const timestamp = nowUnix();
    const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

    const params = new URLSearchParams({
      partner_id: SHOPEE_PARTNER_ID,
      timestamp: String(timestamp),
      access_token: store.access_token,
      shop_id: store.shop_id,
      sign,
      offset: String(offset),
      page_size: String(PRODUCT_LIST_PAGE_SIZE),
      item_status: 'NORMAL',
    });

    const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
    console.log('[shopee-sync] fetching item list, offset:', offset);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      console.error('[shopee-sync] get_item_list failed', data);
      throw new Error(data.message || 'Failed to fetch Shopee product list');
    }

    const items = data.response?.item ?? [];
    itemIdList.push(...items.map((i) => i.item_id));

    more = Boolean(data.response?.more);
    offset += PRODUCT_LIST_PAGE_SIZE;
  }

  console.log('[shopee-sync] total item_id fetched:', itemIdList.length, 'hasMore:', more);
  return { itemIdList, hasMore: more };
}

async function fetchItemDetails(store, itemIdBatch) {
  const path = '/api/v2/product/get_item_base_info';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: store.shop_id,
    sign,
    item_id_list: itemIdBatch.join(','),
  });

  const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
  console.log('[shopee-sync] fetching item details for', itemIdBatch.length, 'items');

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[shopee-sync] get_item_base_info failed', data);
    throw new Error(data.message || 'Failed to fetch Shopee product details');
  }

  const itemList = data.response?.item_list ?? [];

  // Same silent-gap risk as get_order_detail: a partial response just means
  // those products don't get refreshed this cycle with nothing logged to
  // say so, unless flagged here.
  if (itemList.length !== itemIdBatch.length) {
    const returnedIds = new Set(itemList.map((i) => i.item_id));
    const missing = itemIdBatch.filter((id) => !returnedIds.has(id));
    console.warn(
      `[shopee-sync] get_item_base_info returned ${itemList.length}/${itemIdBatch.length} requested item(s) — missing: ${missing.join(', ') || '(unable to determine)'}`
    );
  }

  return itemList;
}

function mapItemToRow(storeId, shopeeItem) {
  const priceInfo = shopeeItem.price_info?.[0] ?? {};
  const stockInfo = shopeeItem.stock_info_v2?.summary_info ?? shopeeItem.stock_info?.[0] ?? {};

  return {
    store_id: storeId,
    platform: 'shopee',
    platform_product_id: String(shopeeItem.item_id),
    title: shopeeItem.item_name ?? null,
    sku: shopeeItem.item_sku ?? null,
    price: priceInfo.current_price ?? null,
    stock: stockInfo.total_available_stock ?? stockInfo.current_stock ?? null,
    image_url: shopeeItem.image?.image_url_list?.[0] ?? null,
    status: shopeeItem.item_status ?? null,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Syncs a single store's product catalogue into Supabase.
 * Expects a store row; refreshes the token internally if needed.
 *
 * options.deadline: absolute Date.now()-comparable timestamp this call must
 * stop starting new work by, same convention as syncStoreOrders. Previously
 * this function had NO time budget at all and wrote one product per Supabase
 * round-trip — on a store with a large catalogue that was, on its own,
 * enough to blow past a 60s maxDuration with no guard to stop it. Defaults
 * to a fresh SYNC_TIME_BUDGET_MS window for standalone callers.
 */
export async function syncStoreProducts(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + SYNC_TIME_BUDGET_MS;

  const canProceed = await acquireSyncLock(store.id, 'products');
  if (!canProceed) {
    console.log(`[shopee-sync] [${store.id}] products sync already in progress elsewhere, skipping`);
    return { storeId: store.id, products: [], locked: true };
  }

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const logId = await logSyncStart(store.id, 'products');

  try {
    const freshStore = await ensureFreshToken(store);

    const { itemIdList, hasMore: listHasMore } = await fetchItemIdList(freshStore, { deadline });
    console.log(
      `[shopee-sync] [${store.id}] fetched ${itemIdList.length} item_id at ${elapsed()}, listHasMore=${listHasMore}`,
    );

    if (itemIdList.length === 0) {
      await logSyncComplete(logId, 'success', 'No products found');
      return { storeId: store.id, products: [], hasMore: listHasMore };
    }

    const batches = chunk(itemIdList, PRODUCT_DETAIL_BATCH_SIZE);
    const savedProducts = [];
    let batchesProcessed = 0;

    for (const batch of batches) {
      if (Date.now() >= deadline) {
        console.log(`[shopee-sync] [${store.id}] products time budget reached at ${elapsed()}, stopping before batch ${batchesProcessed + 1}/${batches.length}`);
        break;
      }

      const shopeeItems = await fetchItemDetails(freshStore, batch);
      const productRows = shopeeItems.map((item) => mapItemToRow(store.id, item));

      // Single multi-row upsert per batch instead of one round-trip per
      // product — same fix that already keeps order sync inside budget.
      const { data: saved, error: upsertError } = await supabaseAdmin
        .from('products')
        .upsert(productRows, { onConflict: 'store_id,platform_product_id' })
        .select();

      if (upsertError) {
        console.error('[shopee-sync] batch product upsert failed for store', store.id, upsertError);
      } else {
        savedProducts.push(...saved);
      }

      batchesProcessed += 1;
      console.log(
        `[shopee-sync] [${store.id}] product batch ${batchesProcessed}/${batches.length} written, ${savedProducts.length} products saved so far at ${elapsed()}`,
      );
    }

    const detailHasMore = batchesProcessed < batches.length;
    const hasMore = listHasMore || detailHasMore;

    await supabaseAdmin
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', store.id);

    const summary = `Synced ${savedProducts.length} products${hasMore ? ', more pending' : ''} in ${Date.now() - t0}ms`;
    await logSyncComplete(logId, 'success', summary);

    return { storeId: store.id, products: savedProducts, hasMore };
  } catch (err) {
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}

/**
 * Records a failed sync attempt for a store (used by callers on catch).
 */
export async function logSyncError(storeId, syncType, message) {
  await logSync(storeId, syncType, 'error', message);
}
