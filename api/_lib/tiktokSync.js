import { TIKTOK_APP_KEY, TIKTOK_API_BASE, generateSign, getValidTikTokToken } from './tiktok.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';
import { selectAllPaged, warnIfAtCap } from './supabaseSelect.js';

// TikTok Shop order sync — sibling to shopeeSync.js's syncStoreOrders, reused
// by api/tiktok.js's ?action=sync and api/cron/sync-all.js. Kept in a
// separate _lib module (not a new serverless function) to stay under the
// Hobby plan's 12-function cap: underscore-prefixed files under api/_lib/
// don't count against it.

const ORDER_SEARCH_PATH = '/order/202309/orders/search';
const ORDER_DETAIL_PATH = '/order/202309/orders';

const ORDER_LIST_PAGE_SIZE = 50;
const ORDER_DETAIL_BATCH_SIZE = 50; // TikTok's documented max ids per orders detail call

// Default to a short window so a single sync stays under the Vercel timeout,
// same convention as shopeeSync.js. Callers may override via { days }.
const DEFAULT_ORDER_TIME_RANGE_DAYS = 7;

// Wall-clock budget for a sync call — same convention as shopeeSync's
// SYNC_TIME_BUDGET_MS. Callers looping over multiple stores in one
// invocation should compute ONE deadline and pass it to every
// syncTikTokShopOrders() call, so the budget is shared across stores.
export const SYNC_TIME_BUDGET_MS = 45_000;

// TikTok Shop's raw order_status enum (Orders API v202309). These values are
// written to orders.order_status VERBATIM — this module deliberately does NOT
// translate them into Shopee's vocabulary.
//
// It used to. That split the mapping across two tables — here, and
// TIKTOK_STATUS_MAP in src/pages/Orders.jsx, which is keyed on the RAW enum —
// and the two drifted: this file wrote READY_TO_SHIP/PROCESSED/SHIPPED, none
// of which the UI's table has keys for, so every TikTok order in those states
// fell through to the "Other" tab. The two also disagreed on ON_HOLD and
// DELIVERED. Shopee's sync stores the platform's raw status and maps exactly
// once, in the UI; TikTok now follows that same pattern.
//
// This set is therefore diagnostics ONLY — it never rewrites a value. It
// exists because the enum below was taken from TikTok's docs and has still
// not been confirmed against a live account, so a status the docs missed
// needs to surface loudly in the cron logs (the UI's own warning only fires
// when someone actually opens the Orders page).
const KNOWN_TIKTOK_STATUSES = new Set([
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'PARTIALLY_SHIPPING',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
]);

// Terminal set, in TikTok's OWN vocabulary. These two statuses happen to be
// spelled identically in Shopee's enum, which is why storing raw values
// (above) left this set unchanged — and why existing COMPLETED/CANCELLED rows
// needed no migration.
const TERMINAL_ORDER_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

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

// Diagnostics only — the raw status is stored either way. A hit here means
// TikTok returned something KNOWN_TIKTOK_STATUSES doesn't list, in which case
// TIKTOK_STATUS_MAP in src/pages/Orders.jsx won't have a key for it either and
// the order will show up under the UI's "Other" tab until both are updated.
function warnIfUnknownStatus(rawStatus, orderId) {
  if (KNOWN_TIKTOK_STATUSES.has(rawStatus)) return;

  console.warn(
    `[tiktok-sync] order ${orderId} has an UNRECOGNISED TikTok order_status "${rawStatus}" — add it to KNOWN_TIKTOK_STATUSES here AND to TIKTOK_STATUS_MAP in src/pages/Orders.jsx. Storing it as-is; it will sit in the UI's "Other" tab until then.`
  );
}

/* ------------------------------- Shop context ------------------------------- */

/**
 * Loads the tiktok_shops row (shop_cipher) for a `stores` row of platform
 * 'tiktok'. Every TikTok API call needs shop_cipher alongside the access
 * token — TikTok rejects requests without it — so this runs first.
 */
async function loadShopCredentials(store) {
  const { data: shop, error } = await supabaseAdmin
    .from('tiktok_shops')
    .select('shop_id, shop_cipher')
    .eq('shop_id', store.shop_id)
    .maybeSingle();

  if (error) throw new Error(`Failed to load tiktok_shops row: ${error.message}`);
  if (!shop) throw new Error(`No tiktok_shops row found for shop_id ${store.shop_id}`);
  if (!shop.shop_cipher) throw new Error(`tiktok_shops row for shop_id ${store.shop_id} has no shop_cipher`);

  return shop;
}

/**
 * Loads `stores` rows for connected TikTok shops — mirrors how Shopee's
 * sync.js/cron load candidate stores: filtered to platform 'tiktok',
 * optionally scoped to one store id, and to active shops when no explicit
 * store is requested. userId is optional so the cron (which syncs every
 * user's connected shops) can omit it.
 */
export async function getTikTokStoresToSync({ userId, storeId } = {}) {
  let query = supabaseAdmin.from('stores').select('*').eq('platform', 'tiktok');
  if (userId) query = query.eq('user_id', userId);
  if (storeId) {
    query = query.eq('id', storeId);
  } else {
    query = query.eq('is_active', true);
  }
  return query;
}

/* ---------------------------------- Orders ---------------------------------- */

async function fetchOrderIdList(shopCipher, accessToken, { days, deadline }) {
  const timeTo = nowUnix();
  const timeFrom = timeTo - days * 24 * 60 * 60;

  const orderIds = [];
  let pageToken = '';
  let more = true;

  while (more && Date.now() < deadline) {
    const timestamp = nowUnix();
    const queryParams = {
      app_key: TIKTOK_APP_KEY,
      shop_cipher: shopCipher,
      timestamp: String(timestamp),
      page_size: String(ORDER_LIST_PAGE_SIZE),
    };
    if (pageToken) queryParams.page_token = pageToken;

    const body = JSON.stringify({
      create_time_ge: timeFrom,
      create_time_lt: timeTo,
    });

    const sign = generateSign(ORDER_SEARCH_PATH, queryParams, body);
    const url = `${TIKTOK_API_BASE}${ORDER_SEARCH_PATH}?${new URLSearchParams({ ...queryParams, sign }).toString()}`;

    console.log('[tiktok-sync] fetching order list, page_token:', pageToken || '(start)');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tts-access-token': accessToken },
      body,
    });
    const data = await response.json();
    console.log('[tiktok-sync] orders/search raw response:', JSON.stringify(data));

    // TikTok returns errors inside HTTP 200s, so `code` in the body is the
    // real signal — not response.ok.
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message || 'Failed to fetch TikTok order list');
    }

    const orders = data.data?.orders ?? [];
    orderIds.push(...orders.map((o) => o.id));

    pageToken = data.data?.next_page_token ?? '';
    more = Boolean(pageToken);
  }

  console.log('[tiktok-sync] total order ids fetched:', orderIds.length, 'hasMore:', more);
  return { orderIds, hasMore: more };
}

async function fetchOrderDetails(shopCipher, accessToken, orderIdBatch) {
  const timestamp = nowUnix();
  const queryParams = {
    app_key: TIKTOK_APP_KEY,
    shop_cipher: shopCipher,
    timestamp: String(timestamp),
    ids: orderIdBatch.join(','),
  };
  const sign = generateSign(ORDER_DETAIL_PATH, queryParams);
  const url = `${TIKTOK_API_BASE}${ORDER_DETAIL_PATH}?${new URLSearchParams({ ...queryParams, sign }).toString()}`;

  console.log('[tiktok-sync] fetching order details for', orderIdBatch.length, 'orders');

  const response = await fetch(url, {
    headers: { 'x-tts-access-token': accessToken },
  });
  const data = await response.json();
  console.log('[tiktok-sync] orders detail raw response:', JSON.stringify(data));

  if (!response.ok || data.code !== 0) {
    throw new Error(data.message || 'Failed to fetch TikTok order details');
  }

  const orders = data.data?.orders ?? [];

  if (orders.length !== orderIdBatch.length) {
    const returnedIds = new Set(orders.map((o) => String(o.id)));
    const missing = orderIdBatch.filter((id) => !returnedIds.has(String(id)));
    console.warn(
      `[tiktok-sync] order detail returned ${orders.length}/${orderIdBatch.length} requested order(s) — missing: ${missing.join(', ') || '(unable to determine)'}`
    );
  }

  return orders;
}

// Fields below are mapped defensively (?? chains across plausibly-named
// fields) because, like KNOWN_TIKTOK_STATUSES, this was written from TikTok's
// documentation without a live response to verify field names against.
function mapOrderToRow(storeId, tiktokOrder) {
  const recipient = tiktokOrder.recipient_address ?? {};
  const payment = tiktokOrder.payment ?? {};

  // Stored verbatim — see KNOWN_TIKTOK_STATUSES. src/pages/Orders.jsx owns the
  // single translation into the shared status labels.
  const rawStatus = tiktokOrder.status ?? null;
  if (rawStatus) warnIfUnknownStatus(rawStatus, tiktokOrder.id);

  const paidTimeRaw = tiktokOrder.paid_time ?? payment.paid_time ?? null;

  return {
    store_id: storeId,
    platform: 'tiktok',
    platform_order_id: String(tiktokOrder.id),
    order_status: rawStatus,
    buyer_name: recipient.name ?? tiktokOrder.buyer_email ?? null,
    shipping_address: recipient.full_address ?? null,
    region: recipient.region_code ?? recipient.district_info?.[0]?.address_name ?? null,
    total_amount: payment.total_amount ?? null,
    currency: payment.currency ?? 'MYR',
    payment_method: tiktokOrder.payment_method_name ?? payment.payment_method ?? null,
    courier_name: tiktokOrder.shipping_provider_name ?? tiktokOrder.delivery_option_name ?? null,
    tracking_number: tiktokOrder.tracking_number ?? tiktokOrder.packages?.[0]?.tracking_number ?? null,
    // Shopee-specific columns (package_number, buyer_cancel_reason, cancel_by,
    // cancel_reason, etc.) are intentionally omitted from this object rather
    // than set to null — omitting a key leaves it untouched on upsert-update,
    // same convention shopeeSync.js's mapOrderToRow uses for tracking_number.
    order_created_at: tiktokOrder.create_time ? new Date(tiktokOrder.create_time * 1000).toISOString() : null,
    paid_at: paidTimeRaw ? new Date(paidTimeRaw * 1000).toISOString() : null,
    synced_at: new Date().toISOString(),
  };
}

function mapItemsToRows(orderId, tiktokOrder) {
  const lineItems = tiktokOrder.line_items ?? [];
  return lineItems.map((item) => ({
    order_id: orderId,
    product_name: item.product_name ?? null,
    variant_name: item.sku_name ?? null,
    sku: item.seller_sku ?? null,
    // TikTok's 202309 line_items are documented as one entry per unit (no
    // confirmed per-line quantity field) — default to 1 rather than guessing
    // a field name that may not exist; an explicit `quantity` is honored if
    // TikTok's live response does carry one.
    quantity: item.quantity ?? 1,
    price: item.sale_price ?? null,
    image_url: item.sku_image ?? null,
  }));
}

// Orders already terminal (COMPLETED/CANCELLED, TikTok's own spelling) never
// change on TikTok's side again, so skip the order-detail round-trip for them
// — UNLESS
// the order has zero order_items rows (self-healing against the same
// order_items concurrency shape shopeeSync.js guards against).
async function fetchTerminalOrderIds(storeId, platformOrderIds) {
  if (platformOrderIds.length === 0) return new Set();

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('platform_order_id, order_status, order_items(count)')
    .eq('store_id', storeId)
    .in('platform_order_id', platformOrderIds);

  if (error) {
    console.error('[tiktok-sync] failed to check existing statuses for terminal-skip, fetching all', error);
    return new Set(); // fail open — skip nothing rather than risk skipping something live
  }

  warnIfAtCap(`orders.tiktokTerminalSkip[${storeId}]`, data);

  return new Set(
    (data ?? [])
      .filter(
        (row) => TERMINAL_ORDER_STATUSES.has(row.order_status) && (row.order_items?.[0]?.count ?? 0) > 0
      )
      .map((row) => row.platform_order_id)
  );
}

// Same guard as shopeeSync.js's existingItemCounts: paged (not a bare
// select), so a batch of orders averaging >20 items each can't hit
// PostgREST's silent 1000-row cap and make an order look itemless.
async function existingItemCounts(orderIds) {
  if (orderIds.length === 0) return new Map();

  const { data, error, truncated } = await selectAllPaged('order_items.tiktokExistingItemCounts', (from, to) =>
    supabaseAdmin.from('order_items').select('order_id').in('order_id', orderIds).range(from, to)
  );

  if (error || truncated) {
    console.error(
      '[tiktok-sync] failed to check existing item counts before an empty item-list write — skipping all affected orders this cycle to be safe',
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

// Same concurrency-safe rewrite (via replace_order_items) and empty-item-list
// guard as shopeeSync.js's writeOrderItemsBatch: an order that comes back
// with an empty/missing line_items array is written only if it previously had
// zero items too — otherwise it's skipped this cycle rather than wiped.
async function writeOrderItemsBatch(itemRowsByOrderId, orderLabelByOrderId = new Map()) {
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
      if (previousCount !== 0) {
        skipOrderIds.add(orderId);
        const label = orderLabelByOrderId.get(orderId) ?? orderId;
        const countLabel = previousCount === -1 ? 'unknown (count query failed)' : previousCount;
        console.error(
          `[tiktok-sync] order ${label} returned an empty item list but previously had ${countLabel} item row(s) — skipping the item write for this order this cycle instead of wiping it; will retry next sync`
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
      '[tiktok-sync] replace_order_items RPC failed — orders keep their previous items until next sync',
      orderIds,
      error
    );
  }
}

// Per-order fallback, used only when the batched upsert below fails outright
// so one malformed row can't sink every other order in the batch — same
// shape as shopeeSync.js's writeOrdersOneByOne.
async function writeOrdersOneByOne(storeId, tiktokOrders) {
  const savedOrders = [];

  for (const tiktokOrder of tiktokOrders) {
    const orderRow = mapOrderToRow(storeId, tiktokOrder);

    const { data: savedOrder, error: upsertError } = await supabaseAdmin
      .from('orders')
      .upsert(orderRow, { onConflict: 'store_id,platform_order_id' })
      .select()
      .single();

    if (upsertError) {
      console.error('[tiktok-sync] failed to upsert order', tiktokOrder.id, upsertError);
      continue;
    }

    const itemRows = mapItemsToRows(savedOrder.id, tiktokOrder);
    await writeOrderItemsBatch(
      new Map([[savedOrder.id, itemRows]]),
      new Map([[savedOrder.id, tiktokOrder.id]])
    );

    savedOrders.push(savedOrder);
  }

  return savedOrders;
}

async function writeOrderBatch(storeId, tiktokOrders) {
  const orderRows = tiktokOrders.map((o) => mapOrderToRow(storeId, o));

  const { data: savedOrders, error: upsertError } = await supabaseAdmin
    .from('orders')
    .upsert(orderRows, { onConflict: 'store_id,platform_order_id' })
    .select('id, platform_order_id');

  if (upsertError) {
    console.error(
      '[tiktok-sync] batch order upsert failed, falling back to per-order upserts for this batch',
      tiktokOrders.map((o) => o.id),
      upsertError
    );
    return writeOrdersOneByOne(storeId, tiktokOrders);
  }

  const savedIdByPlatformId = new Map(savedOrders.map((o) => [o.platform_order_id, o.id]));
  const labelByOrderId = new Map(savedOrders.map((o) => [o.id, o.platform_order_id]));
  const itemRowsByOrderId = new Map();

  for (const tiktokOrder of tiktokOrders) {
    const orderId = savedIdByPlatformId.get(String(tiktokOrder.id));
    if (!orderId) continue; // shouldn't happen — upsert didn't error, so every row should be present
    itemRowsByOrderId.set(orderId, mapItemsToRows(orderId, tiktokOrder));
  }

  await writeOrderItemsBatch(itemRowsByOrderId, labelByOrderId);

  return savedOrders;
}

/**
 * Syncs a single TikTok shop's recent orders (and their line items) into
 * Supabase. `store` must be a `stores` row with platform 'tiktok' — its
 * store.shop_id links to the tiktok_shops row that holds shop_cipher, and
 * store.id (the stores mirror row id, NOT tiktok_shops.id) is what gets
 * written to orders.store_id, since that FK points at stores.
 *
 * options.deadline: absolute Date.now()-comparable timestamp this call must
 * stop starting new work by, same convention as shopeeSync's
 * syncStoreOrders — callers looping over multiple shops in one invocation
 * should share ONE deadline across every call.
 */
export async function syncTikTokShopOrders(store, options = {}) {
  const days = options.days ?? DEFAULT_ORDER_TIME_RANGE_DAYS;
  const deadline = options.deadline ?? Date.now() + SYNC_TIME_BUDGET_MS;

  const canProceed = await acquireSyncLock(store.id, 'tiktok_orders');
  if (!canProceed) {
    console.log(`[tiktok-sync] [${store.id}] orders sync already in progress elsewhere, skipping`);
    return { storeId: store.id, orders: [], synced: 0, hasMore: false, locked: true };
  }

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const logId = await logSyncStart(store.id, 'tiktok_orders');

  try {
    const { shop_cipher: shopCipher } = await loadShopCredentials(store);
    const accessToken = await getValidTikTokToken(store.shop_id);
    console.log(`[tiktok-sync] [${store.id}] token+cipher ready at ${elapsed()}`);

    const { orderIds, hasMore: listHasMore } = await fetchOrderIdList(shopCipher, accessToken, { days, deadline });
    console.log(
      `[tiktok-sync] [${store.id}] fetched ${orderIds.length} order id(s) (last ${days}d) at ${elapsed()}, listHasMore=${listHasMore}`
    );

    if (orderIds.length === 0) {
      await logSyncComplete(logId, 'success', 'No orders found in range');
      return { storeId: store.id, orders: [], synced: 0, hasMore: listHasMore };
    }

    const terminalIds = await fetchTerminalOrderIds(store.id, orderIds.map(String));
    const toFetch = orderIds.filter((id) => !terminalIds.has(String(id)));
    console.log(
      `[tiktok-sync] [${store.id}] ${terminalIds.size} already terminal (skipped), ${toFetch.length} to fetch at ${elapsed()}`
    );

    const batches = chunk(toFetch, ORDER_DETAIL_BATCH_SIZE);
    const savedOrders = [];
    let batchesProcessed = 0;

    for (const batch of batches) {
      if (Date.now() >= deadline) {
        console.log(
          `[tiktok-sync] [${store.id}] time budget reached at ${elapsed()}, stopping before batch ${batchesProcessed + 1}/${batches.length}`
        );
        break;
      }

      const tiktokOrders = await fetchOrderDetails(shopCipher, accessToken, batch);
      const saved = await writeOrderBatch(store.id, tiktokOrders);
      savedOrders.push(...saved);
      batchesProcessed += 1;

      console.log(
        `[tiktok-sync] [${store.id}] batch ${batchesProcessed}/${batches.length} written, ${savedOrders.length} orders saved so far at ${elapsed()}`
      );
    }

    const detailHasMore = batchesProcessed < batches.length;
    const hasMore = listHasMore || detailHasMore;

    await supabaseAdmin
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', store.id);

    const summary = `Synced ${savedOrders.length} orders (${terminalIds.size} already-terminal skipped)${hasMore ? ', more pending' : ''} in ${Date.now() - t0}ms`;
    await logSyncComplete(logId, 'success', summary);

    console.log(
      `[tiktok-sync] [${store.id}] done: synced ${savedOrders.length} orders in ${elapsed()}, hasMore=${hasMore}`
    );

    return { storeId: store.id, orders: savedOrders, synced: savedOrders.length, hasMore };
  } catch (err) {
    console.error(`[tiktok-sync] [${store.id}] failed:`, err);
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}
