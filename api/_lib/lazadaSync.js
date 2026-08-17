import { LAZADA_APP_KEY, generateSign, getValidLazadaToken } from './lazada.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';
import { selectAllPaged, warnIfAtCap } from './supabaseSelect.js';

// Lazada order sync — sibling to tiktokSync.js's syncTikTokShopOrders and
// shopeeSync.js's syncStoreOrders, reused by api/lazada.js's ?action=sync and
// api/cron/sync-all.js. Kept in a separate _lib module (not a new serverless
// function) to stay under the Hobby plan's 12-function cap: underscore-prefixed
// files under api/_lib/ don't count against it.
//
// Every field name, response shape and error convention below was confirmed
// against a LIVE Lazada response via a throwaway ?action=probe endpoint before
// this file was written — unlike tiktokSync.js, none of it is inferred from
// documentation. The specific findings that shaped the code are called out at
// the points where they matter.

const ORDERS_PATH = '/orders/get';
const ORDER_ITEMS_PATH = '/orders/items/get';

// Lazada caps /orders/get at 100 per page, and /orders/items/get at 50 order
// ids per call.
const ORDER_LIST_PAGE_SIZE = 100;
const ORDER_ITEMS_BATCH_SIZE = 50;

// Default to a short window so a single sync stays under the Vercel timeout,
// same convention as shopeeSync.js/tiktokSync.js. Callers may override via
// { days }.
const DEFAULT_ORDER_TIME_RANGE_DAYS = 7;

// Wall-clock budget for a sync call — same convention as shopeeSync's and
// tiktokSync's SYNC_TIME_BUDGET_MS. Callers looping over multiple stores in
// one invocation should compute ONE deadline and pass it to every
// syncLazadaShopOrders() call, so the budget is shared across stores.
export const SYNC_TIME_BUDGET_MS = 45_000;

// CONFIRMED: Lazada's business APIs live on per-country gateways. The generic
// api.lazada.com/rest host that LAZADA_API_HOST in _lib/lazada.js points at is
// NOT used here — the country gateway is resolved from lazada_shops.country.
const COUNTRY_GATEWAYS = {
  MY: 'https://api.lazada.com.my/rest',
  SG: 'https://api.lazada.sg/rest',
  TH: 'https://api.lazada.co.th/rest',
  ID: 'https://api.lazada.co.id/rest',
  PH: 'https://api.lazada.com.ph/rest',
  VN: 'https://api.lazada.vn/rest',
};

// Lazada has no order-level currency field, so it comes from the shop's
// country. Defaults to MYR to match the orders table default.
const COUNTRY_CURRENCIES = {
  MY: 'MYR',
  SG: 'SGD',
  TH: 'THB',
  ID: 'IDR',
  PH: 'PHP',
  VN: 'VND',
};

/* ------------------------------ Status handling ----------------------------- */

// Lazada's raw statuses are written to orders.order_status VERBATIM. The single
// translation into the app's shared status labels lives in
// src/pages/Orders.jsx's LAZADA_STATUS_MAP — deliberately NOT here. Converting
// into Shopee's vocabulary at sync time is exactly the bug that put every
// TikTok order in the UI's "Other" tab (two tables mapping the same thing,
// drifting apart); Shopee stores raw and maps once, and so does this.
//
// Progress ranks drive the least-progressed-wins collapse below. Lower rank =
// earlier in the lifecycle = more likely to still need seller action.
//
// `confirmed` is UNDER REVIEW and is very likely dead weight here. It was
// observed in the ORDER-LEVEL `statuses` array (the source deriveOrderStatus no
// longer reads) and is not in Lazada's published item-status list, which points
// to it being an order/payment-level state that item status never uses. Ranking
// it below `packed` is what let it beat shipped/delivered siblings under
// least-progressed-wins. It is kept for now because the fallback path can still
// feed order-level values in, and because removing it before the temporary
// [lazada-sync][DIAG] log has proved it absent from item status would only swap
// one unverified assumption for another. Once a run confirms that, delete it
// here and delete `confirmed: 'To Pack'` from LAZADA_STATUS_MAP in
// src/pages/Orders.jsx together — dropping it here alone would make any
// straggler land in the UI's "Other" tab.
//
// LIVE statuses only. A terminal status goes in COLLAPSE_TERMINAL_STATUSES
// instead and needs no rank — the collapse filters those out before it ever
// compares ranks.
const STATUS_PROGRESS_RANK = {
  unpaid: 0,
  pending: 1,
  confirmed: 2,
  packed: 3,
  ready_to_ship: 4,
  shipped: 5,
  delivered: 6,
};

// Statuses meaning "this line is finished and needs nothing further". Used ONLY
// by the collapse below — see TERMINAL_ORDER_STATUSES for the (narrower) set
// that governs skipping API round trips.
//
// The reverse-logistics statuses (shipped_back, shipped_back_success,
// package_returned) belong HERE rather than in STATUS_PROGRESS_RANK above.
// The two tables are mutually exclusive in effect: `live` below is defined as
// "not in this set", so a status listed here never reaches the rank
// comparison, and a rank given to it would be dead weight. Membership in
// EITHER table is what marks a status recognised, so listing them here is also
// what silences the UNRECOGNISED warning.
//
// `shipped_back` is included even though the parcel is still in transit back.
// It is terminal in the only sense this set means — the seller has no action
// left that would move it forward, and it must not be allowed to outrank a
// sibling item that still needs packing. That is a separate question from
// whether the ORDER can still change, which TERMINAL_ORDER_STATUSES answers
// differently below.
const COLLAPSE_TERMINAL_STATUSES = new Set([
  'canceled',
  'returned',
  'failed',
  'shipped_back',
  'shipped_back_success',
  'package_returned',
]);

// When EVERY entry is terminal, this decides which one represents the order.
// Ordered most-consequential first: a return moved money and goods both ways,
// a failure may still need chasing, a cancellation is the quiet case.
//
// The return family sits at the front as one block, ordered most-settled
// first, so an order carrying several of them is described by its furthest-
// along line. All four map to 'Returned' in Orders.jsx's LAZADA_STATUS_MAP, so
// the ordering within the block only affects the raw value stored, never which
// tab the order lands in.
const TERMINAL_PRECEDENCE = [
  'returned',
  'shipped_back_success',
  'package_returned',
  'shipped_back',
  'failed',
  'canceled',
];

// Statuses an order can never leave, so the item round trip can be skipped for
// them entirely (see fetchTerminalOrderIds).
//
// Deliberately NARROWER than COLLAPSE_TERMINAL_STATUSES: `delivered` is
// excluded because a delivered order can still become `returned`, and `failed`
// is excluded because a failed delivery can still move to shipped_back. Both
// would otherwise be frozen at a stale status forever. The saving from skipping
// is small anyway — /orders/get returns full order detail for free, so this
// only avoids the /orders/items/get call, never the order data itself.
//
// The reverse-logistics statuses are excluded for exactly that reason and are
// NOT added here. `shipped_back` is the clearest case — a parcel in transit
// back is still moving and will become shipped_back_success (or fail), so
// freezing it would strand it mid-return, the same trap `failed` is kept out
// to avoid. shipped_back_success and package_returned look settled, but the
// upside of skipping is one items call while the downside is a permanently
// stale row, so they stay out too until there is a reason to optimise.
const TERMINAL_ORDER_STATUSES = new Set(['canceled', 'returned']);

/**
 * Collapses a LIST of Lazada statuses into the single value stored in
 * orders.order_status. Shopee and TikTok both hand back a scalar status; Lazada
 * does not, because a multi-item order can be partially shipped and carry
 * e.g. ["shipped", "pending"].
 *
 * Callers pass the PER-ITEM `status` values — see deriveOrderStatus, which owns
 * the choice of source and is the only thing that should call this. The
 * order-level `statuses` array is now only a fallback for when no per-item
 * status is available.
 *
 * Least-progressed-wins: if ANY entry is still live, the least-progressed live
 * entry represents the order, so a part that still needs packing surfaces in an
 * actionable tab instead of hiding behind a shipped sibling. Terminal statuses
 * are only allowed to represent the order when EVERY entry is terminal.
 *
 * An unrecognised status always wins outright. That is intentional: it makes a
 * vocabulary change loud (the UI has no label for it either, so the order lands
 * in the "Other" tab and warns) rather than silently mis-bucketing the order.
 */
function collapseStatuses(rawStatuses, orderId) {
  const statuses = (Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim());

  if (statuses.length === 0) {
    console.warn(`[lazada-sync] order ${orderId} has no usable statuses value:`, JSON.stringify(rawStatuses));
    return null;
  }

  const unknown = statuses.filter(
    (s) => STATUS_PROGRESS_RANK[s] === undefined && !COLLAPSE_TERMINAL_STATUSES.has(s)
  );
  if (unknown.length > 0) {
    console.warn(
      `[lazada-sync] order ${orderId} carries UNRECOGNISED status(es) ${JSON.stringify(unknown)} out of ${JSON.stringify(statuses)} — add them here (STATUS_PROGRESS_RANK if the seller can still act on it, COLLAPSE_TERMINAL_STATUSES if it is finished) AND to LAZADA_STATUS_MAP in src/pages/Orders.jsx. Storing "${unknown[0]}" as-is; it will sit in the UI's "Other" tab until then.`
    );
    return unknown[0];
  }

  const live = statuses.filter((s) => !COLLAPSE_TERMINAL_STATUSES.has(s));

  if (live.length > 0) {
    const collapsed = live.reduce((best, s) =>
      STATUS_PROGRESS_RANK[s] < STATUS_PROGRESS_RANK[best] ? s : best
    );
    if (statuses.length > 1) {
      console.log(
        `[lazada-sync] order ${orderId} statuses ${JSON.stringify(statuses)} collapsed to "${collapsed}" (least-progressed live entry)`
      );
    }
    return collapsed;
  }

  const collapsed = TERMINAL_PRECEDENCE.find((s) => statuses.includes(s)) ?? statuses[0];
  if (statuses.length > 1) {
    console.log(
      `[lazada-sync] order ${orderId} statuses ${JSON.stringify(statuses)} are all terminal, collapsed to "${collapsed}"`
    );
  }
  return collapsed;
}

/**
 * Picks the status list that represents an order, and collapses it.
 *
 * PER-ITEM `status` from /orders/items/get is the source, NOT the order-level
 * `statuses` array from /orders/get. The order-level array was the original
 * source and was wrong: it reports `confirmed` — an order/payment-level state
 * that is not in Lazada's item-status vocabulary and never advances through
 * fulfilment — so orders sat at `confirmed` for months while their items were
 * shipped and delivered. 102 of 129 orders were stored that way, each with a
 * tracking_code written into the SAME row by the SAME upsert from the SAME
 * fetch pair, which is what proves the contradiction lives inside one Lazada
 * response rather than between two syncs.
 *
 * `confirmed` being ranked below `packed` in STATUS_PROGRESS_RANK compounded it:
 * under least-progressed-wins it beat every real fulfilment status it appeared
 * next to. That rank entry is deliberately left in place for now — see the note
 * on it above — because it is harmless once nothing feeds `confirmed` in, and
 * removing it before the diagnostic below has confirmed the vocabulary in live
 * data would just be a second unverified guess.
 *
 * Costs no extra API calls: the items are already fetched for tracking_code and
 * the order_items rows.
 *
 * Statuses are deduplicated first. Lazada returns ONE ROW PER UNIT (see
 * mapItemsToRows), so a 3-unit order would otherwise hand collapseStatuses
 * ["shipped","shipped","shipped"] and trip its multi-status log line on every
 * ordinary order. The collapse is order-insensitive and idempotent over
 * duplicates, so this changes nothing but the noise.
 */
function deriveOrderStatus(lazadaOrder, items) {
  const orderId = lazadaOrder.order_id;

  const itemStatuses = [
    ...new Set(items.map((i) => i.status).filter((s) => typeof s === 'string' && s.trim() !== '')),
  ];

  // FALLBACK 1 — nothing usable came back at item level. Covers the empty-items
  // path (fetchOrderItems' batch-miss warning) and an items response that
  // carries no status field at all. Without this an itemless order would be
  // written with a null status.
  if (itemStatuses.length === 0) {
    console.warn(
      `[lazada-sync] order ${orderId} has no usable per-item status (${items.length} item row(s)) — falling back to the order-level statuses array, which is known to under-report fulfilment progress`
    );
    return collapseStatuses(lazadaOrder.statuses, orderId);
  }

  const collapsed = collapseStatuses(itemStatuses, orderId);

  // CONFIRMED: items_count equals the item row count (one row per unit), so a
  // short item list means we are looking at a PARTIAL view of the order.
  const expectedItemCount = Number(lazadaOrder.items_count ?? 0);
  const partialItemList = expectedItemCount > 0 && items.length < expectedItemCount;

  // FALLBACK 2 — a partial item list that happens to be all-terminal must not
  // be allowed to conclude `canceled`/`returned`. Those two are the whole of
  // TERMINAL_ORDER_STATUSES, so storing one makes fetchTerminalOrderIds skip
  // this order's item fetch on EVERY later sync — a wrong value there strands
  // the order permanently instead of self-healing. The unseen items may still
  // be live, and there is no way to tell from what came back, so this defers
  // rather than guesses. The order-level statuses array is never
  // canceled/returned-only for a live order, so falling back cannot freeze it,
  // and the order stays eligible for a correct read next cycle.
  if (partialItemList && TERMINAL_ORDER_STATUSES.has(collapsed)) {
    console.error(
      `[lazada-sync] order ${orderId} returned only ${items.length} of ${expectedItemCount} item(s) and they collapse to the freezing status "${collapsed}" — refusing to store it from a partial item list (it would skip every future item fetch); falling back to the order-level statuses array this cycle`
    );
    return collapseStatuses(lazadaOrder.statuses, orderId);
  }

  if (partialItemList) {
    console.warn(
      `[lazada-sync] order ${orderId} returned only ${items.length} of ${expectedItemCount} item(s) — "${collapsed}" is derived from a partial item list and may be more-progressed than the true order status`
    );
  }

  return collapsed;
}

/* ==========================================================================
 * ⚠️  TEMPORARY DIAGNOSTIC — DELETE AFTER ONE SYNC RUN HAS BEEN INSPECTED  ⚠️
 * ==========================================================================
 *
 * Confirms the per-item-vs-order-level diagnosis in live data across the full
 * order set, rather than the 5 orders the original ?action=probe sampled. That
 * probe asked whether `statuses` was multi-valued but never compared it against
 * item status, which is exactly how the wrong field got shipped.
 *
 * TO REMOVE: delete this function and its single call in mapOrderToRow.
 *
 * Logs STATUS FIELDS ONLY — no buyer name, phone or address, unlike the
 * ?action=probe endpoint this replaces. tracking_code is reported as a boolean,
 * never the number itself.
 *
 * Grep a run for `[lazada-sync][DIAG]`. The two things to read off it:
 *   - order_level vs item_statuses: if order_level is ["confirmed"] while
 *     item_statuses holds shipped/delivered, the diagnosis holds and `confirmed`
 *     never appears at item level at all.
 *   - any `confirmed` inside item_statuses: if it DOES appear there, it is a
 *     real item status and its STATUS_PROGRESS_RANK entry has to stay (and its
 *     rank needs establishing from observation, not assumption).
 */
function logStatusDiagnostic(lazadaOrder, items, derived) {
  console.log(
    '[lazada-sync][DIAG]',
    JSON.stringify({
      order_id: String(lazadaOrder.order_id),
      order_level_statuses: lazadaOrder.statuses ?? null,
      item_statuses: items.map((i) => i.status ?? null),
      distinct_item_statuses: [...new Set(items.map((i) => i.status ?? null))],
      items_seen: items.length,
      items_count_field: lazadaOrder.items_count ?? null,
      any_tracking_code: items.some((i) => i.tracking_code != null && String(i.tracking_code).trim() !== ''),
      derived_status: derived,
      order_level_would_have_been: collapseStatuses(lazadaOrder.statuses, lazadaOrder.order_id),
    })
  );
}

/* --------------------------------- Requests --------------------------------- */

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Lazada wants ISO 8601 WITH an explicit timezone offset
 * ("2026-08-09T00:00:00+08:00"). Date#toISOString() emits milliseconds and a
 * "Z", which Lazada rejects.
 *
 * The offset is fixed at +08:00 rather than derived from the shop's country on
 * purpose: this renders a specific INSTANT, and the same instant expressed at
 * +08:00 or +07:00 is the same moment in time. The offset only changes the wall
 * clock reading, never which orders fall inside the window.
 */
function toLazadaIso(date, offsetHours = 8) {
  const shifted = new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offsetHours >= 0 ? '+' : '-';
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.abs(offsetHours))}:00`
  );
}

/**
 * Signs and issues one Lazada GET.
 *
 * CONFIRMED: access_token MUST be part of the signature base string — signing
 * without it returns IncompleteSignature — so it goes into the object handed to
 * generateSign, not just onto the URL.
 *
 * CONFIRMED: Lazada reports failures inside HTTP 200s and its success code is
 * the STRING "0", never numeric 0. `body.code !== '0'` is therefore the real
 * signal, not response.ok.
 */
async function lazadaGet(host, path, accessToken, params, label) {
  const signedParams = {
    app_key: LAZADA_APP_KEY,
    access_token: accessToken,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    ...params,
  };
  const sign = generateSign(path, signedParams);
  const url = `${host}${path}?${new URLSearchParams({ ...signedParams, sign }).toString()}`;

  const response = await fetch(url);
  const body = await response.json();
  console.log(`[lazada-sync] ${label} raw response:`, JSON.stringify(body));

  if (!response.ok || body.code !== '0') {
    throw new Error(
      `Lazada ${label} failed (code=${body.code}, message=${body.message ?? 'none'}, request_id=${body.request_id ?? 'none'})`
    );
  }

  return body;
}

/* -------------------------------- Shop context ------------------------------- */

/**
 * Resolves the lazada_shops row backing a `stores` row of platform 'lazada'.
 *
 * Looked up by store_id FIRST, not seller_id: lazada_shops' unique key is
 * (seller_id, country), so a seller connected in two countries has two rows and
 * a seller_id lookup is ambiguous. store_id is written by api/lazada.js's
 * callback and is one-to-one with the stores mirror row. The seller_id fallback
 * only exists for legacy rows connected before store_id was populated.
 */
async function loadShopCredentials(store) {
  const { data: byStore, error: byStoreError } = await supabaseAdmin
    .from('lazada_shops')
    .select('seller_id, country, store_id')
    .eq('store_id', store.id)
    .maybeSingle();

  if (byStoreError) throw new Error(`Failed to load lazada_shops row: ${byStoreError.message}`);
  if (byStore) return { sellerId: byStore.seller_id, country: (byStore.country || 'MY').toUpperCase() };

  const { data: bySeller, error: bySellerError } = await supabaseAdmin
    .from('lazada_shops')
    .select('seller_id, country, store_id')
    .eq('seller_id', String(store.shop_id));

  if (bySellerError) throw new Error(`Failed to load lazada_shops row: ${bySellerError.message}`);
  if (!bySeller || bySeller.length === 0) {
    throw new Error(`No lazada_shops row found for store ${store.id} (seller_id ${store.shop_id})`);
  }
  if (bySeller.length > 1) {
    console.warn(
      `[lazada-sync] seller_id ${store.shop_id} has ${bySeller.length} lazada_shops rows (multi-country) and none linked to store ${store.id} — using the first. Backfill lazada_shops.store_id to remove this ambiguity.`
    );
  }

  return { sellerId: bySeller[0].seller_id, country: (bySeller[0].country || 'MY').toUpperCase() };
}

/**
 * Loads `stores` rows for connected Lazada shops — mirrors
 * getTikTokStoresToSync: filtered to platform 'lazada', optionally scoped to
 * one store id, and to active shops when no explicit store is requested.
 * userId is optional so the cron (which syncs every user's connected shops) can
 * omit it.
 */
export async function getLazadaStoresToSync({ userId, storeId } = {}) {
  let query = supabaseAdmin.from('stores').select('*').eq('platform', 'lazada');
  if (userId) query = query.eq('user_id', userId);
  if (storeId) {
    query = query.eq('id', storeId);
  } else {
    query = query.eq('is_active', true);
  }
  return query;
}

/* ---------------------------------- Orders ---------------------------------- */

/**
 * Pages through /orders/get.
 *
 * Windowed on update_after/update_before, NOT created_after: an order whose
 * status changes days after it was placed — paid, packed, shipped, returned —
 * must stay inside the rolling window so the next sync still picks it up.
 * updated_at is bumped at creation too, so nothing newly-placed is lost. Same
 * reasoning as shopeeSync.js's time_range_field: 'update_time'.
 *
 * update_before pins the upper edge of the window to a single instant captured
 * before paging starts. That matters because Lazada pages by OFFSET, not by
 * cursor: without a fixed upper bound, orders updated mid-pagination would
 * reshuffle under an updated_at sort and rows could be skipped between pages.
 *
 * Unlike TikTok's orders/search (ids only), /orders/get returns FULL order
 * detail, so this returns the order objects themselves and no second call is
 * needed for anything except line items.
 */
async function fetchOrders(host, accessToken, { days, deadline }) {
  const updateBefore = toLazadaIso(new Date());
  const updateAfter = toLazadaIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

  const orders = [];
  let offset = 0;
  let more = true;

  while (more && Date.now() < deadline) {
    console.log(`[lazada-sync] fetching order page at offset ${offset}`);

    const body = await lazadaGet(
      host,
      ORDERS_PATH,
      accessToken,
      {
        update_after: updateAfter,
        update_before: updateBefore,
        sort_by: 'updated_at',
        sort_direction: 'ASC',
        offset: String(offset),
        limit: String(ORDER_LIST_PAGE_SIZE),
      },
      'orders/get'
    );

    const page = body.data?.orders ?? [];
    orders.push(...page);
    offset += page.length;

    const countTotal = Number(body.data?.countTotal ?? 0);

    // A short page is the definitive end-of-results signal; countTotal is the
    // secondary guard. The page.length === 0 case is covered by the first
    // condition, which also makes an infinite loop impossible.
    if (page.length < ORDER_LIST_PAGE_SIZE) {
      more = false;
    } else if (countTotal > 0 && offset >= countTotal) {
      more = false;
    }
  }

  console.log('[lazada-sync] total orders fetched:', orders.length, 'hasMore:', more);
  return { orders, hasMore: more };
}

/**
 * Fetches line items for up to ORDER_ITEMS_BATCH_SIZE orders.
 *
 * CONFIRMED: order_ids must be a NUMERIC JSON array — [511276315484488, ...],
 * not quoted strings.
 *
 * CONFIRMED: the response nests, `data` being an array of
 * { order_id, order_number, order_items[] } — it is NOT a flat item array — so
 * this returns a Map keyed by String(order_id).
 */
async function fetchOrderItems(host, accessToken, orderIdBatch) {
  console.log('[lazada-sync] fetching items for', orderIdBatch.length, 'orders');

  const body = await lazadaGet(
    host,
    ORDER_ITEMS_PATH,
    accessToken,
    { order_ids: JSON.stringify(orderIdBatch.map(Number)) },
    'orders/items/get'
  );

  const entries = Array.isArray(body.data) ? body.data : [];
  const itemsByOrderId = new Map();
  for (const entry of entries) {
    itemsByOrderId.set(String(entry.order_id), entry.order_items ?? []);
  }

  if (entries.length !== orderIdBatch.length) {
    const missing = orderIdBatch.filter((id) => !itemsByOrderId.has(String(id)));
    console.warn(
      `[lazada-sync] items call returned ${entries.length}/${orderIdBatch.length} requested order(s) — missing: ${missing.join(', ') || '(unable to determine)'}`
    );
  }

  return itemsByOrderId;
}

/* --------------------------------- Mapping ---------------------------------- */

/**
 * Maps one Lazada order (plus its already-fetched items) to an `orders` row.
 *
 * CONFIRMED: buyer PII is MASKED under this app's permission scope —
 * first_name, last_name, phone and address1 all come back masked or empty. So
 * buyer_name, buyer_phone and shipping_address are OMITTED from this object
 * entirely rather than written as masked junk. Omitting a key leaves the column
 * untouched on an upsert-update, the same convention tiktokSync.js uses for
 * Shopee-only columns. city / post_code / country are clean, and city is what
 * feeds `region`.
 *
 * Also omitted, because Lazada has no equivalent at all: paid_at, and every
 * Shopee-specific column (package_number, cancel_reason, buyer_message, ...).
 */
function mapOrderToRow(storeId, currency, lazadaOrder, items) {
  const shipping = lazadaOrder.address_shipping ?? {};
  const firstItem = items[0] ?? {};

  const orderStatus = deriveOrderStatus(lazadaOrder, items);
  logStatusDiagnostic(lazadaOrder, items, orderStatus); // TEMPORARY — see logStatusDiagnostic

  return {
    store_id: storeId,
    platform: 'lazada',
    platform_order_id: String(lazadaOrder.order_id),
    order_status: orderStatus,
    region: shipping.city ?? null,
    total_amount: lazadaOrder.price ?? null,
    currency,
    payment_method: lazadaOrder.payment_method ?? null,
    // Courier and tracking are ITEM-level on Lazada, not order-level. A
    // multi-package order has several; the schema holds one, the same
    // single-value limitation Shopee's package_number already has.
    courier_name: firstItem.shipment_provider ?? null,
    tracking_number: firstItem.tracking_code ?? null,
    // CONFIRMED: created_at arrives as "2026-08-08 14:16:45 +0800", which
    // new Date() parses correctly.
    order_created_at: lazadaOrder.created_at ? new Date(lazadaOrder.created_at).toISOString() : null,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Maps a Lazada order's items to `order_items` rows.
 *
 * CONFIRMED: Lazada returns ONE ROW PER UNIT with no quantity field —
 * item_rows_per_order matched items_count exactly in the live sample. Left
 * as-is, an order of 3 identical units would render as 3 separate lines of
 * qty 1, so identical units are collapsed by (shop_sku, item_price) into a
 * single line carrying the real quantity.
 *
 * Grouping is on item_price (the list price, stable across units of the same
 * SKU) while the stored unit price is paid_price (what the buyer actually paid
 * after vouchers). Where those diverge between units of one group, the first
 * unit's paid_price represents the line.
 */
function mapItemsToRows(orderId, items) {
  const groups = new Map();

  for (const item of items) {
    // Falls back to order_item_id so an item with no shop_sku is never merged
    // into an unrelated group — it just stays on its own line.
    const key = `${item.shop_sku ?? `#${item.order_item_id}`}|${item.item_price ?? ''}`;
    const existing = groups.get(key);

    if (existing) {
      existing.quantity += 1;
      continue;
    }

    groups.set(key, {
      order_id: orderId,
      product_name: item.name ?? null,
      variant_name: item.variation ?? null,
      sku: item.shop_sku ?? null,
      quantity: 1,
      price: item.paid_price ?? null,
      image_url: item.product_main_image ?? null,
    });
  }

  return [...groups.values()];
}

/* ---------------------------------- Writes ---------------------------------- */

// Orders already terminal (canceled/returned — see TERMINAL_ORDER_STATUSES)
// never change on Lazada's side again, so skip the item round-trip for them —
// UNLESS the order has zero order_items rows (self-healing against the same
// order_items concurrency shape shopeeSync.js guards against).
async function fetchTerminalOrderIds(storeId, platformOrderIds) {
  if (platformOrderIds.length === 0) return new Set();

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('platform_order_id, order_status, order_items(count)')
    .eq('store_id', storeId)
    .in('platform_order_id', platformOrderIds);

  if (error) {
    console.error('[lazada-sync] failed to check existing statuses for terminal-skip, fetching all', error);
    return new Set(); // fail open — skip nothing rather than risk skipping something live
  }

  warnIfAtCap(`orders.lazadaTerminalSkip[${storeId}]`, data);

  return new Set(
    (data ?? [])
      .filter(
        (row) => TERMINAL_ORDER_STATUSES.has(row.order_status) && (row.order_items?.[0]?.count ?? 0) > 0
      )
      .map((row) => row.platform_order_id)
  );
}

// Same guard as shopeeSync.js's/tiktokSync.js's existingItemCounts: paged (not
// a bare select), so a batch of orders averaging >20 items each can't hit
// PostgREST's silent 1000-row cap and make an order look itemless.
async function existingItemCounts(orderIds) {
  if (orderIds.length === 0) return new Map();

  const { data, error, truncated } = await selectAllPaged('order_items.lazadaExistingItemCounts', (from, to) =>
    supabaseAdmin.from('order_items').select('order_id').in('order_id', orderIds).range(from, to)
  );

  if (error || truncated) {
    console.error(
      '[lazada-sync] failed to check existing item counts before an empty item-list write — skipping all affected orders this cycle to be safe',
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
// guard as shopeeSync.js/tiktokSync.js: an order that comes back with an
// empty/missing item array is written only if it previously had zero items too
// — otherwise it's skipped this cycle rather than wiped.
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
          `[lazada-sync] order ${label} returned an empty item list but previously had ${countLabel} item row(s) — skipping the item write for this order this cycle instead of wiping it; will retry next sync`
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
      '[lazada-sync] replace_order_items RPC failed — orders keep their previous items until next sync',
      orderIds,
      error
    );
  }
}

// Per-order fallback, used only when the batched upsert below fails outright so
// one malformed row can't sink every other order in the batch — same shape as
// tiktokSync.js's writeOrdersOneByOne.
async function writeOrdersOneByOne(storeId, currency, lazadaOrders, itemsByOrderId) {
  const savedOrders = [];

  for (const lazadaOrder of lazadaOrders) {
    const items = itemsByOrderId.get(String(lazadaOrder.order_id)) ?? [];
    const orderRow = mapOrderToRow(storeId, currency, lazadaOrder, items);

    const { data: savedOrder, error: upsertError } = await supabaseAdmin
      .from('orders')
      .upsert(orderRow, { onConflict: 'store_id,platform_order_id' })
      .select()
      .single();

    if (upsertError) {
      console.error('[lazada-sync] failed to upsert order', lazadaOrder.order_id, upsertError);
      continue;
    }

    const itemRows = mapItemsToRows(savedOrder.id, items);
    await writeOrderItemsBatch(
      new Map([[savedOrder.id, itemRows]]),
      new Map([[savedOrder.id, lazadaOrder.order_id]])
    );

    savedOrders.push(savedOrder);
  }

  return savedOrders;
}

async function writeOrderBatch(storeId, currency, lazadaOrders, itemsByOrderId) {
  const orderRows = lazadaOrders.map((o) =>
    mapOrderToRow(storeId, currency, o, itemsByOrderId.get(String(o.order_id)) ?? [])
  );

  const { data: savedOrders, error: upsertError } = await supabaseAdmin
    .from('orders')
    .upsert(orderRows, { onConflict: 'store_id,platform_order_id' })
    .select('id, platform_order_id');

  if (upsertError) {
    console.error(
      '[lazada-sync] batch order upsert failed, falling back to per-order upserts for this batch',
      lazadaOrders.map((o) => o.order_id),
      upsertError
    );
    return writeOrdersOneByOne(storeId, currency, lazadaOrders, itemsByOrderId);
  }

  const savedIdByPlatformId = new Map(savedOrders.map((o) => [o.platform_order_id, o.id]));
  const labelByOrderId = new Map(savedOrders.map((o) => [o.id, o.platform_order_id]));
  const itemRowsByOrderId = new Map();

  for (const lazadaOrder of lazadaOrders) {
    const orderId = savedIdByPlatformId.get(String(lazadaOrder.order_id));
    if (!orderId) continue; // shouldn't happen — upsert didn't error, so every row should be present
    itemRowsByOrderId.set(orderId, mapItemsToRows(orderId, itemsByOrderId.get(String(lazadaOrder.order_id)) ?? []));
  }

  await writeOrderItemsBatch(itemRowsByOrderId, labelByOrderId);

  return savedOrders;
}

/* ----------------------------------- Sync ----------------------------------- */

/**
 * Syncs a single Lazada shop's recent orders (and their line items) into
 * Supabase. `store` must be a `stores` row with platform 'lazada' — its
 * store.shop_id is the Lazada seller_id, and store.id (the stores mirror row
 * id, NOT lazada_shops.id) is what gets written to orders.store_id, since that
 * FK points at stores.
 *
 * options.deadline: absolute Date.now()-comparable timestamp this call must
 * stop starting new work by, same convention as shopeeSync's/tiktokSync's —
 * callers looping over multiple shops in one invocation should share ONE
 * deadline across every call.
 */
export async function syncLazadaShopOrders(store, options = {}) {
  const days = options.days ?? DEFAULT_ORDER_TIME_RANGE_DAYS;
  const deadline = options.deadline ?? Date.now() + SYNC_TIME_BUDGET_MS;

  const canProceed = await acquireSyncLock(store.id, 'lazada_orders');
  if (!canProceed) {
    console.log(`[lazada-sync] [${store.id}] orders sync already in progress elsewhere, skipping`);
    return { storeId: store.id, orders: [], synced: 0, hasMore: false, locked: true };
  }

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const logId = await logSyncStart(store.id, 'lazada_orders');

  try {
    const { sellerId, country } = await loadShopCredentials(store);
    const host = COUNTRY_GATEWAYS[country];
    if (!host) {
      throw new Error(`No Lazada API gateway known for country "${country}" (seller ${sellerId})`);
    }
    const currency = COUNTRY_CURRENCIES[country] ?? 'MYR';

    const accessToken = await getValidLazadaToken(sellerId);
    console.log(`[lazada-sync] [${store.id}] token ready for ${country} (${host}) at ${elapsed()}`);

    const { orders: allOrders, hasMore: listHasMore } = await fetchOrders(host, accessToken, { days, deadline });
    console.log(
      `[lazada-sync] [${store.id}] fetched ${allOrders.length} order(s) (last ${days}d) at ${elapsed()}, listHasMore=${listHasMore}`
    );

    if (allOrders.length === 0) {
      await logSyncComplete(logId, 'success', 'No orders found in range');
      return { storeId: store.id, orders: [], synced: 0, hasMore: listHasMore };
    }

    const terminalIds = await fetchTerminalOrderIds(
      store.id,
      allOrders.map((o) => String(o.order_id))
    );
    const toFetch = allOrders.filter((o) => !terminalIds.has(String(o.order_id)));
    console.log(
      `[lazada-sync] [${store.id}] ${terminalIds.size} already terminal (skipped), ${toFetch.length} to fetch at ${elapsed()}`
    );

    const batches = chunk(toFetch, ORDER_ITEMS_BATCH_SIZE);
    const savedOrders = [];
    let batchesProcessed = 0;

    for (const batch of batches) {
      if (Date.now() >= deadline) {
        console.log(
          `[lazada-sync] [${store.id}] time budget reached at ${elapsed()}, stopping before batch ${batchesProcessed + 1}/${batches.length}`
        );
        break;
      }

      const itemsByOrderId = await fetchOrderItems(
        host,
        accessToken,
        batch.map((o) => o.order_id)
      );
      const saved = await writeOrderBatch(store.id, currency, batch, itemsByOrderId);
      savedOrders.push(...saved);
      batchesProcessed += 1;

      console.log(
        `[lazada-sync] [${store.id}] batch ${batchesProcessed}/${batches.length} written, ${savedOrders.length} orders saved so far at ${elapsed()}`
      );
    }

    const itemsHasMore = batchesProcessed < batches.length;
    const hasMore = listHasMore || itemsHasMore;

    await supabaseAdmin
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', store.id);

    const summary = `Synced ${savedOrders.length} orders (${terminalIds.size} already-terminal skipped)${hasMore ? ', more pending' : ''} in ${Date.now() - t0}ms`;
    await logSyncComplete(logId, 'success', summary);

    console.log(
      `[lazada-sync] [${store.id}] done: synced ${savedOrders.length} orders in ${elapsed()}, hasMore=${hasMore}`
    );

    return { storeId: store.id, orders: savedOrders, synced: savedOrders.length, hasMore };
  } catch (err) {
    console.error(`[lazada-sync] [${store.id}] failed:`, err);
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}
