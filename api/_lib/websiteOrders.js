import crypto from 'crypto';
import { supabaseAdmin } from './supabaseAdmin.js';
import { notifyStore } from './pushNotify.js';

// Webhook ingest for catsplaytoy.com — the 'website' platform. Sibling to
// shopeeSync.js / tiktokSync.js / lazadaSync.js, but inverted: those POLL a
// marketplace API on a cron, this is PUSHED to by our own site, so there is no
// token, no refresh, no pagination and no time-budget loop. One delivery, one
// order.
//
// Lives in api/_lib/ (not as its own serverless function) for the same reason
// every other sync module does: underscore-prefixed files here don't count
// against the Vercel Hobby 12-function cap, and api/website.js is the 12th and
// LAST function this project can add on that plan. Anything further must reuse
// an existing route with an ?action= parameter.
//
// Trust boundary: everything in the request is attacker-controlled until
// verifyDelivery() has passed. Nothing in this module reads the database
// before that point.

const WEBSITE_PLATFORM = 'website';
const WEBSITE_SHOP_ID = 'catsplaytoy.com';

// Spec: reject a delivery whose X-Timestamp is more than 5 minutes off. Applied
// in BOTH directions — a future-dated timestamp is just as much a sign of a
// replay or a broken clock as a stale one, and only checking the past half
// would let an attacker mint a signature valid indefinitely.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// The four events catsplaytoy.com sends today. An unrecognised event is logged
// and still applied (the order's own status is what gets stored), because
// dropping an order we were told about is worse than storing one whose event
// name we don't recognise yet.
const KNOWN_EVENTS = new Set(['order.paid', 'order.shipped', 'order.cancelled', 'order.refunded']);

// Raw status values, stored in orders.order_status VERBATIM — the single
// translation into the app's canonical labels lives in WEBSITE_STATUS_MAP in
// src/lib/orderStatus.js, never here. Same arrangement Shopee has, and the one
// TikTok had to be fixed into. This set is used ONLY to decide whether to warn;
// an unknown status is still written through, and surfaces in the Orders page's
// "Other" tab rather than vanishing.
const KNOWN_STATUSES = new Set(['paid', 'shipped', 'cancelled', 'refunded']);

// The status that means "a new order needs packing". The push notification
// fires only for this one.
const NEW_ORDER_STATUS = 'paid';

// How long notifyStore() gets. The sender wants a fast 2xx and retries anything
// else, so the push must never be what makes a delivery time out: a push that
// doesn't fit is skipped (its orders keep notified_new_at NULL and the next
// delivery — or the next cron tick, once a website store is included there —
// picks them up, still once-only).
const PUSH_BUDGET_MS = 8_000;

/* ------------------------------- Raw body -------------------------------- */

/**
 * Reads the exact request bytes.
 *
 * MUST BE THE FIRST THING THE HANDLER DOES, before anything touches req.body.
 *
 * The signature covers `X-Timestamp + "." + rawBody`, so verification needs the
 * bytes as sent. Re-serialising req.body with JSON.stringify is NOT equivalent
 * and must never be used as a fallback: PROBED against this project on the
 * Vercel Node runtime (`vercel dev`, 2026-10-11), a 283-byte body came back as
 * 282 bytes once round-tripped through the parser — the sender's trailing
 * newline was gone. Key order, number formatting and unicode escaping can
 * diverge the same way, which would produce signature failures that are
 * intermittent and unreproducible.
 *
 * The same probe established that `export const config = { api: { bodyParser:
 * false } }` is IGNORED by this runtime (req.body was still a parsed object
 * with it set), so opting out of the parser is not available — reading the
 * stream before the parser does is the whole mechanism. Hence the ordering
 * requirement above, and hence assertRawBodyUsable() below, which turns the
 * failure mode of that ordering into an unmistakable error instead of a
 * mysterious signature mismatch.
 */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Distinguishes "the runtime consumed the body before we could read it" from
 * "the signature is wrong" — two failures that otherwise look identical from
 * the outside and have completely different fixes.
 *
 * Returns an error string, or null when the raw body is usable.
 */
export function assertRawBodyUsable(req, rawBody) {
  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);

  if (rawBody.length === 0 && Number.isFinite(declared) && declared > 0) {
    return (
      `raw request body was empty but Content-Length is ${declared} — the runtime parsed the ` +
      'body before readRawBody() could read it. Signature verification is IMPOSSIBLE in this ' +
      'state; do not "fix" it by signing JSON.stringify(req.body). See readRawBody() in ' +
      'api/_lib/websiteOrders.js.'
    );
  }

  if (Number.isFinite(declared) && declared > 0 && rawBody.length !== declared) {
    return `raw body is ${rawBody.length} byte(s) but Content-Length is ${declared} — truncated read`;
  }

  return null;
}

/* ----------------------------- Verification ------------------------------ */

/**
 * X-Timestamp's wire format is not pinned by the spec, so all three plausible
 * encodings are accepted: unix seconds, unix milliseconds, and ISO 8601.
 *
 * This only affects the SKEW CHECK. The signature is always computed over the
 * header's raw string exactly as received, so a guess here can never make a
 * bad signature verify — at worst it makes a well-formed delivery look stale,
 * which fails closed.
 */
function parseTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // 10 digits is seconds, 13 is milliseconds. Threshold rather than digit
    // count so it keeps working past the year 2286.
    const ms = n < 1e11 ? n * 1000 : n;
    return Number.isFinite(ms) ? ms : null;
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Verifies one delivery's timestamp and HMAC signature.
 *
 * Returns { ok: true } or { ok: false, status, reason } — `reason` is for OUR
 * logs, and the caller deliberately does not echo it to the sender (see
 * api/website.js): telling an unauthenticated caller which half of the check
 * failed, or how far off its clock is, is free reconnaissance.
 *
 * Order matters: the timestamp is checked BEFORE the HMAC, so a flood of
 * replayed or garbage deliveries is rejected on a string parse instead of a
 * hash computation.
 */
export function verifyDelivery({ rawBody, timestampHeader, signatureHeader, now = Date.now() }) {
  const secret = process.env.MYSTOREHUB_WEBHOOK_SECRET;

  // A missing secret is a CONFIGURATION error and must fail closed. There is
  // deliberately no "skip verification when unset" development path: that is
  // the one bug that would silently accept forged orders in production.
  if (!secret) {
    return {
      ok: false,
      status: 500,
      reason: 'MYSTOREHUB_WEBHOOK_SECRET is not set — refusing to accept unverified deliveries',
    };
  }

  if (typeof signatureHeader !== 'string' || signatureHeader.trim() === '') {
    return { ok: false, status: 401, reason: 'missing X-Signature' };
  }

  const sentAtMs = parseTimestamp(timestampHeader);
  if (sentAtMs === null) {
    return { ok: false, status: 401, reason: `unparseable X-Timestamp: ${String(timestampHeader)}` };
  }

  const skewMs = Math.abs(now - sentAtMs);
  if (skewMs > MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      status: 401,
      reason: `X-Timestamp is ${Math.round(skewMs / 1000)}s off (limit ${MAX_CLOCK_SKEW_MS / 1000}s)`,
    };
  }

  // Signed string per the spec: the timestamp header VERBATIM, a literal dot,
  // then the raw body bytes. Built as a Buffer rather than a template string so
  // the body is never forced through a JS string round-trip.
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestampHeader}.`, 'utf8'),
    rawBody,
  ]);

  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const provided = signatureHeader.trim().toLowerCase();

  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first — and compared on the hex strings, which leaks only the length of a
  // value the attacker already chose.
  if (provided.length !== expected.length) {
    return { ok: false, status: 401, reason: 'signature length mismatch' };
  }

  const matches = crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  if (!matches) {
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }

  return { ok: true, sentAtMs };
}

/* -------------------------------- Mapping -------------------------------- */

/**
 * Integer sen -> a decimal(10,2)-safe string.
 *
 * Returned as a STRING via toFixed(2), not a JS number: 6280 sen is 62.80, and
 * handing Postgres '62.80' removes any question of float representation on the
 * way into a decimal column. Getting this wrong by a factor of 100 would
 * overstate revenue a hundredfold, which is why the migration's verify script
 * asserts the resulting value rather than trusting it.
 */
export function centsToAmount(cents) {
  if (cents === null || cents === undefined) return null;
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return (Math.round(n) / 100).toFixed(2);
}

function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toIso(value) {
  const ms = parseTimestamp(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Flattens the payload's structured shipping_address into the single
 * `shipping_address` text column the other platforms also write.
 *
 * The recipient's full_name is included as the first line on purpose: website
 * orders are packed and labelled BY HAND (no AWB integration — see
 * PRINTABLE_PLATFORMS in src/lib/awb.js), so whoever writes the parcel needs
 * the recipient name together with the address, and it is not always the
 * account holder in orders.buyer_name (gift orders).
 */
function formatShippingAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;

  const cityLine = [nonEmpty(addr.postcode), nonEmpty(addr.city)].filter(Boolean).join(' ');

  const lines = [
    nonEmpty(addr.full_name),
    nonEmpty(addr.address_line1),
    nonEmpty(addr.address_line2),
    nonEmpty(cityLine),
    nonEmpty(addr.state),
    nonEmpty(addr.country),
  ].filter(Boolean);

  return lines.length === 0 ? null : lines.join(', ');
}

/**
 * Maps one delivery's `order` object to an `orders` row.
 *
 * order_status is written VERBATIM (see KNOWN_STATUSES above).
 *
 * Columns deliberately omitted so an upsert-UPDATE leaves them untouched —
 * the same convention lazadaSync.js/tiktokSync.js use for fields their platform
 * has no concept of: every Shopee-only column (package_number, awb_url,
 * awb_printed, auto_pack_*, cancel_reason, buyer_message, ...). Auto-pack and
 * AWB printing never run for this platform, so those stay NULL forever.
 *
 * Fields in the payload with NO column to land in, recorded here so it is clear
 * they were seen and dropped rather than missed: customer.email,
 * subtotal_cents, discount_cents, discount_code, shipping_cents, payment_ref,
 * tracking_url, and each item's line_total_cents. total_cents is the figure the
 * revenue report uses, and it is already net of discount and inclusive of
 * shipping per the spec's own arithmetic (5980 - 500 + 800 = 6280).
 */
export function mapOrderToRow(order, storeId, deliverySentAtIso) {
  const shipping = order.shipping_address ?? {};

  return {
    store_id: storeId,
    platform: WEBSITE_PLATFORM,
    platform_order_id: String(order.order_no),
    order_status: String(order.status),
    buyer_name: nonEmpty(order.customer?.name),
    buyer_phone: nonEmpty(order.customer?.phone),
    shipping_address: formatShippingAddress(shipping),
    // `state`, not `city`: region is a coarse grouping in this app's UI, and
    // Lazada's sync feeds it a city only because Lazada exposes nothing better.
    region: nonEmpty(shipping.state) ?? nonEmpty(shipping.city),
    total_amount: centsToAmount(order.total_cents),
    currency: nonEmpty(order.currency) ?? 'MYR',
    payment_method: nonEmpty(order.payment_method),
    courier_name: nonEmpty(order.courier),
    tracking_number: nonEmpty(order.tracking_no),
    paid_at: toIso(order.paid_at),
    // shipped_at is not just informational: Phase 3's status mapping reads it
    // to decide whether a 'refunded' order belongs in the Returns tab (goods
    // went out and are coming back) or the Cancelled tab (nothing ever
    // shipped). Keep writing it.
    shipped_at: toIso(order.shipped_at),
    order_created_at: toIso(order.created_at),
    synced_at: new Date().toISOString(),
    // The out-of-order guard (see section C of
    // supabase/website_platform_migration.sql).
    website_event_sent_at: deliverySentAtIso,
  };
}

/**
 * Maps the payload's items to `order_items` rows.
 *
 * Unlike Lazada (one row per unit, no quantity field) the website sends a real
 * `quantity` per line, so there is nothing to collapse — lines are written
 * one-for-one, preserving two separate lines for the same SKU if the site sent
 * them that way.
 *
 * price is the UNIT price. line_total_cents is dropped: order_items has no
 * column for it and it is derivable, so storing it would create a second
 * number that could disagree with quantity x price.
 *
 * image_url is always null — the payload carries no product image. Order cards
 * fall back to a placeholder tile (see OrderImage in src/pages/Orders.jsx), so
 * this degrades cleanly rather than breaking a layout.
 */
export function mapItemsToRows(orderId, items) {
  if (!Array.isArray(items)) return [];

  return items.map((item) => ({
    order_id: orderId,
    product_name: nonEmpty(item.product_name),
    variant_name: nonEmpty(item.variant_name),
    sku: nonEmpty(item.sku),
    quantity: Number.isFinite(Number(item.quantity)) ? Math.round(Number(item.quantity)) : null,
    price: centsToAmount(item.unit_price_cents),
    image_url: null,
  }));
}

/* ------------------------------- Validation ------------------------------ */

/**
 * Structural checks only — never business rules. Returns an error string or
 * null.
 *
 * Only order_no and status are REQUIRED: without order_no there is no upsert
 * key and the row could not be identified or updated later, and without status
 * the order could not be routed to a tab or counted. Everything else is
 * optional and simply lands as NULL, which is the same tolerance the
 * marketplace syncs show toward fields their platform masks or omits.
 */
export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'body is not a JSON object';

  const order = payload.order;
  if (!order || typeof order !== 'object') return 'missing `order` object';
  if (!nonEmpty(order.order_no)) return 'missing `order.order_no`';
  if (!nonEmpty(order.status)) return 'missing `order.status`';

  if (order.items !== undefined && order.items !== null && !Array.isArray(order.items)) {
    return '`order.items` is present but not an array';
  }

  return null;
}

/* ------------------------------ Store lookup ----------------------------- */

// Cached across warm invocations: one row, seeded by section A of
// supabase/website_platform_migration.sql, that never changes.
let cachedStore = null;

export async function resolveWebsiteStore() {
  if (cachedStore) return cachedStore;

  const { data, error } = await supabaseAdmin
    .from('stores')
    .select('id, user_id, shop_id, shop_name, platform')
    .eq('platform', WEBSITE_PLATFORM)
    .eq('shop_id', WEBSITE_SHOP_ID)
    .maybeSingle();

  if (error) throw new Error(`load website store: ${error.message}`);

  // The migration creates this row and raises if it could not. Reaching here
  // means the migration was never run against THIS project — worth saying
  // explicitly, because every downstream symptom (orders written with a null
  // store_id, or invisible under RLS) is far more confusing than the cause.
  if (!data) {
    throw new Error(
      `no stores row with platform='${WEBSITE_PLATFORM}' and shop_id='${WEBSITE_SHOP_ID}' — ` +
        'run supabase/website_platform_migration.sql against this Supabase project'
    );
  }

  cachedStore = data;
  return cachedStore;
}

/* ---------------------------- Delivery claiming -------------------------- */

/**
 * Claims a delivery_id, returning false if it was already processed.
 *
 * CLAIM-FIRST, not record-after: the insert is what makes a retry cheap, so it
 * has to happen before the work. `ignoreDuplicates` makes this
 * `ON CONFLICT DO NOTHING`, and an empty returned array means some earlier
 * invocation already owns this delivery.
 *
 * Paired with releaseDelivery() on failure — see applyDelivery().
 */
async function claimDelivery(payload, headers) {
  const order = payload.order ?? {};

  const { data, error } = await supabaseAdmin
    .from('website_webhook_events')
    .upsert(
      {
        delivery_id: headers.deliveryId,
        event: nonEmpty(payload.event) ?? nonEmpty(headers.event),
        order_no: nonEmpty(order.order_no),
        status: nonEmpty(order.status),
        sent_at: toIso(payload.sent_at),
      },
      { onConflict: 'delivery_id', ignoreDuplicates: true }
    )
    .select('id');

  if (error) throw new Error(`claim delivery: ${error.message}`);

  return (data ?? []).length > 0;
}

/**
 * Hands a claimed delivery back so the sender's retry can pick it up again.
 *
 * Without this, a delivery that was claimed and then failed mid-write would be
 * seen as a duplicate on retry and answered 200 — the order silently never
 * written. That is the one failure mode worth more code than it looks like it
 * deserves.
 */
async function releaseDelivery(deliveryId) {
  const { error } = await supabaseAdmin
    .from('website_webhook_events')
    .delete()
    .eq('delivery_id', deliveryId);

  if (error) {
    // Logged, not thrown: the caller is already failing, and this is the
    // secondary error. It does mean the retry will be treated as a duplicate,
    // so it must be loud.
    console.error(
      `[website] FAILED TO RELEASE delivery ${deliveryId} after an error — the sender's retry ` +
        'will be treated as a duplicate and this order may never be written. Delete the row ' +
        'from website_webhook_events by hand to let it retry.',
      error
    );
  }
}

/* --------------------------------- Writes -------------------------------- */

/**
 * True when this delivery is older than what has already been applied to the
 * order, i.e. a late retry overtaken by a newer event.
 *
 * Why this exists at all: delivery_id dedupe stops the SAME delivery applying
 * twice, but two DIFFERENT deliveries can still arrive out of order —
 * order.paid fails, order.shipped succeeds, then order.paid's retry lands and
 * would take the order back to 'paid' and wipe the tracking number. See
 * section C of supabase/website_platform_migration.sql.
 *
 * Benign race, accepted knowingly: two deliveries for one order processed
 * concurrently both read the old value and both write. At this shop's volume
 * (one site, manual fulfilment) concurrent deliveries for the SAME order are
 * not a real scenario, and the cost of being wrong is one stale status that
 * the next delivery corrects. Expressing it as a conditional UPDATE instead
 * would mean giving up the upsert, which is what creates the row in the first
 * place.
 */
async function isStaleDelivery(storeId, orderNo, deliverySentAtIso) {
  if (!deliverySentAtIso) return false;

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('website_event_sent_at')
    .eq('store_id', storeId)
    .eq('platform_order_id', orderNo)
    .maybeSingle();

  if (error) throw new Error(`load existing order: ${error.message}`);
  if (!data || !data.website_event_sent_at) return false;

  return new Date(data.website_event_sent_at).getTime() > new Date(deliverySentAtIso).getTime();
}

/**
 * Upserts the order and rewrites its items.
 *
 * Items go through the replace_order_items() RPC, exactly as every other sync
 * does — a delete-then-insert inside ONE transaction, so two concurrent writers
 * can't race into leaving an order with zero items (see the function's comment
 * in supabase/schema.sql).
 *
 * EMPTY-ITEM GUARD, carried over from lazadaSync.js/shopeeSync.js: a delivery
 * whose item array is empty or missing is written only if the order had no
 * items before either. Otherwise the item write is SKIPPED and the existing
 * rows are kept. A status-only event (order.shipped carrying just tracking
 * info) must never be able to blank out an order's contents.
 */
async function writeOrder(store, order, deliverySentAtIso) {
  const orderRow = mapOrderToRow(order, store.id, deliverySentAtIso);

  const { data: savedOrder, error: upsertError } = await supabaseAdmin
    .from('orders')
    .upsert(orderRow, { onConflict: 'store_id,platform_order_id' })
    .select('id, platform_order_id')
    .single();

  if (upsertError) throw new Error(`upsert order ${order.order_no}: ${upsertError.message}`);

  const itemRows = mapItemsToRows(savedOrder.id, order.items);

  if (itemRows.length === 0) {
    const { count, error: countError } = await supabaseAdmin
      .from('order_items')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', savedOrder.id);

    if (countError) {
      console.error(
        `[website] could not count existing items for ${order.order_no} — skipping the item ` +
          'write this delivery rather than risking a wipe',
        countError
      );
      return { orderId: savedOrder.id, itemsWritten: null };
    }

    if ((count ?? 0) > 0) {
      console.warn(
        `[website] delivery for ${order.order_no} carried no items but the order already has ` +
          `${count} item row(s) — keeping them and skipping the item write`
      );
      return { orderId: savedOrder.id, itemsWritten: 0 };
    }
  }

  const { error: itemsError } = await supabaseAdmin.rpc('replace_order_items', {
    p_order_ids: [savedOrder.id],
    p_items: itemRows,
  });

  if (itemsError) {
    // Not fatal: the order itself is written and visible. Throwing here would
    // make the sender retry the whole delivery, and the retry would hit the
    // same RPC failure — so this is surfaced in the logs and the order keeps
    // whatever items it had.
    console.error(
      `[website] replace_order_items failed for ${order.order_no} — the order is saved but its ` +
        'items were not updated',
      itemsError
    );
    return { orderId: savedOrder.id, itemsWritten: null };
  }

  return { orderId: savedOrder.id, itemsWritten: itemRows.length };
}

/* ------------------------------ Orchestration ---------------------------- */

/**
 * Applies one VERIFIED delivery. The caller must have run verifyDelivery()
 * first — nothing here re-checks the signature.
 *
 * Returns { outcome, ... } where outcome is one of:
 *   'duplicate' — this delivery_id was already processed (claim lost)
 *   'stale'     — a newer event has already been applied to this order
 *   'applied'   — the order was written
 * All three are 2xx from the sender's point of view: they mean "we have it",
 * and only a genuine failure throws, so only a genuine failure gets retried.
 */
export async function applyDelivery({ payload, headers, deadline }) {
  const order = payload.order;
  const orderNo = String(order.order_no);
  const status = String(order.status);
  const deliverySentAtIso = toIso(payload.sent_at);

  if (!KNOWN_STATUSES.has(status)) {
    console.warn(
      `[website] unknown order.status "${status}" for ${orderNo} — storing it verbatim. It will ` +
        'show in the Orders page "Other" tab and will NOT count as revenue until ' +
        'WEBSITE_STATUS_MAP in src/lib/orderStatus.js and the website branches in ' +
        'supabase/website_platform_migration.sql are updated.'
    );
  }

  if (!KNOWN_EVENTS.has(payload.event)) {
    console.warn(`[website] unknown event "${payload.event}" for ${orderNo} — applying anyway`);
  }

  const store = await resolveWebsiteStore();

  const claimed = await claimDelivery(payload, headers);
  if (!claimed) {
    console.log(`[website] delivery ${headers.deliveryId} already processed — no-op`);
    return { outcome: 'duplicate', orderNo };
  }

  try {
    if (await isStaleDelivery(store.id, orderNo, deliverySentAtIso)) {
      console.log(
        `[website] delivery ${headers.deliveryId} for ${orderNo} (sent ${deliverySentAtIso}) is ` +
          'older than what is already applied — recorded and skipped'
      );
      return { outcome: 'stale', orderNo };
    }

    const { orderId, itemsWritten } = await writeOrder(store, order, deliverySentAtIso);

    console.log(
      `[website] applied ${payload.event} for ${orderNo} (status ${status}, ` +
        `${itemsWritten === null ? 'items unchanged' : `${itemsWritten} item(s)`})`
    );

    // Push only for a brand-new paid order. notifyStore() owns the batching,
    // the per-device locale, the sync lock and the notified_new_at stamping
    // that makes every order notified exactly once — this just triggers it, as
    // the Shopee cron path does. It never throws outward: a failed push must
    // not turn into a non-2xx and have the whole order redelivered.
    let notified = 0;
    if (status === NEW_ORDER_STATUS) {
      const pushDeadline = Math.min(deadline ?? Infinity, Date.now() + PUSH_BUDGET_MS);
      try {
        const result = await notifyStore(store, { deadline: pushDeadline });
        notified = result.sent ?? 0;
      } catch (err) {
        console.error(`[website] push notify failed for ${orderNo} (order is saved)`, err);
      }
    }

    return { outcome: 'applied', orderNo, orderId, itemsWritten, notified };
  } catch (err) {
    // Give the delivery back so the sender's retry can do this again.
    await releaseDelivery(headers.deliveryId);
    throw err;
  }
}
