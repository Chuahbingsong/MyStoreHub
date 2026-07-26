import webpush from 'web-push';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';

// Server-side Web Push sender, run from the cron path (api/cron/sync-all.js)
// after a store's orders have been synced into Supabase. Sends ONE batched
// notification per store per event — "Kardon — 3 new orders" rather than three
// separate pushes — and stamps the persisted marker columns
// orders.notified_new_at / notified_cancel_at (same "touch once" pattern as
// auto_pack_status) so every order is counted in exactly ONE notification,
// ever. Dedup is NEVER in-memory state.
//
// One notification PER STORE (not one combined across stores): the store name
// is the most useful thing to lead with, and each event's deep-link
// (/orders?tab=new, /orders?tab=cancelRequests) lands on a tab that already
// shows that store's orders — a combined "5 across 3 stores" push would drop
// the store identity and still deep-link to the same generic tab. It also fits
// the architecture: notifyStore runs per-store and concurrently, each with its
// own deadline, so there is no cross-store aggregation point to hook without
// complicating the once-only stamping.

// Shopee order_status values that count as "a new, actionable order" — the ones
// that land in the Orders page "New Orders" tab. UNPAID is deliberately
// excluded: an order sitting unpaid isn't yet something to act on.
const NEW_ORDER_STATUSES = ['READY_TO_SHIP', 'INVOICE_PENDING'];

// Per-event cap. The COUNT shown in a batched notification MUST equal the
// number of orders actually stamped this run — otherwise an order could be
// counted here and again next run. Capping the candidate set caps both
// together: any overflow simply becomes the next run's own (also once-only)
// notification with its own smaller count.
const MAX_NOTIFY_PER_RUN = 50;

// Notification copy, per locale. Lives here rather than the React i18n layer in
// src/lib/i18n because notifications are generated server-side by the cron —
// the client translations are never in scope in a serverless function. Each
// push_subscriptions row carries the locale it was created under, so a zh
// device gets Chinese copy even though one cron run notifies all of a user's
// devices at once. Chinese has no plural form, so a single phrasing reads
// naturally for any count ("1 个新订单" / "3 个新订单").
const MESSAGES = {
  en: {
    newOrders: (n) => (n === 1 ? '1 new order' : `${n} new orders`),
    cancels: (n) => (n === 1 ? '1 cancellation request' : `${n} cancellation requests`),
  },
  'zh-CN': {
    newOrders: (n) => `${n} 个新订单`,
    cancels: (n) => `${n} 个取消申请`,
  },
};

function messagesFor(locale) {
  return MESSAGES[locale] ?? MESSAGES.en;
}

// True once configured — cached across warm invocations. Missing keys is a
// configuration error, not a per-order one: log once and skip, never throw.
let vapidConfigured = null;

function ensureVapidConfigured() {
  if (vapidConfigured !== null) return vapidConfigured;

  const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    console.error(
      '[push] VAPID env not fully configured — need VITE_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT'
    );
    vapidConfigured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

function newOrderPayload(storeName, count, locale, tag) {
  return {
    title: storeName,
    body: messagesFor(locale).newOrders(count),
    url: '/orders?tab=new',
    tag,
    requireInteraction: true,
  };
}

function cancelPayload(storeName, count, locale, tag) {
  return {
    title: storeName,
    body: messagesFor(locale).cancels(count),
    url: '/orders?tab=cancelRequests',
    tag,
    requireInteraction: true,
  };
}

// Sends one logical notification to every subscription for the user, formatting
// the payload per-subscription so each device gets its own locale. Returns the
// set of subscription ids whose endpoint is gone (HTTP 410/404) so the caller
// can delete them — a dead device must not error every cycle forever.
async function sendToSubscriptions(subscriptions, makePayload) {
  const goneSubscriptionIds = new Set();
  let delivered = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(makePayload(sub.locale || 'en'))
      )
    )
  );

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      delivered += 1;
      return;
    }
    failed += 1;
    const statusCode = result.reason?.statusCode;
    if (statusCode === 410 || statusCode === 404) {
      goneSubscriptionIds.add(subscriptions[i].id);
    } else {
      console.error(
        `[push] send failed (status ${statusCode ?? 'unknown'}) for endpoint ${subscriptions[i].endpoint}`,
        result.reason?.body || result.reason?.message || result.reason
      );
    }
  });

  return { goneSubscriptionIds, delivered, failed };
}

async function deleteSubscriptions(ids) {
  if (ids.size === 0) return;
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .in('id', [...ids]);
  if (error) {
    console.error('[push] failed to delete expired subscriptions', [...ids], error);
  } else {
    console.log(`[push] deleted ${ids.size} expired subscription(s)`);
  }
}

// Stamps EVERY order in a batch so none is ever notified for this event again —
// called after the send attempt, regardless of per-device delivery success (a
// transient delivery failure must not cause a re-notify next tick; it's
// surfaced in sync_logs / console instead). The count already shown to the user
// equals this batch's size, so stamping the whole batch is what keeps the
// once-only guarantee intact under batching.
async function stampNotifiedBatch(orderIds, column) {
  if (orderIds.length === 0) return;
  const { error } = await supabaseAdmin
    .from('orders')
    .update({ [column]: new Date().toISOString() })
    .in('id', orderIds);
  if (error) {
    console.error(`[push] failed to stamp ${column} for ${orderIds.length} order(s)`, error);
  }
}

/**
 * Notifies a store's owner about newly-actionable orders and buyer cancellation
 * requests, as ONE batched notification per event with the order count and
 * store name. Shares the caller's per-store deadline — never a fresh window —
 * and is a no-op cost when the user has no push subscriptions (every candidate
 * is still stamped so enabling push later doesn't blast history).
 *
 * options.deadline: absolute Date.now()-comparable timestamp to stop by.
 */
export async function notifyStore(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;

  if (!ensureVapidConfigured()) {
    return { storeId: store.id, sent: 0, skipped: 'vapid-not-configured' };
  }

  if (Date.now() >= deadline) {
    return { storeId: store.id, sent: 0, skipped: 'no-time-budget' };
  }

  // One lock across cron/foreground so overlapping runs can't double-send
  // before the markers are stamped.
  const canProceed = await acquireSyncLock(store.id, 'push');
  if (!canProceed) {
    console.log(`[push] [${store.id}] already in progress elsewhere, skipping`);
    return { storeId: store.id, sent: 0, locked: true };
  }

  const logId = await logSyncStart(store.id, 'push');

  try {
    // New actionable orders: never notified, currently in a "new" status.
    const { data: newOrders, error: newErr } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('store_id', store.id)
      .is('notified_new_at', null)
      .in('order_status', NEW_ORDER_STATUSES)
      .order('order_created_at', { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN);

    if (newErr) throw new Error(`load new-order candidates: ${newErr.message}`);

    // Buyer-initiated cancellation requests: never notified, still in flight.
    const { data: cancelOrders, error: cancelErr } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('store_id', store.id)
      .is('notified_cancel_at', null)
      .eq('order_status', 'IN_CANCEL')
      .eq('cancel_by', 'buyer')
      .order('order_created_at', { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN);

    if (cancelErr) throw new Error(`load cancel candidates: ${cancelErr.message}`);

    const newIds = (newOrders ?? []).map((o) => o.id);
    const cancelIds = (cancelOrders ?? []).map((o) => o.id);

    if (newIds.length === 0 && cancelIds.length === 0) {
      await logSyncComplete(logId, 'success', 'No orders to notify');
      return { storeId: store.id, sent: 0 };
    }

    const storeName = store.shop_name || store.shop_id;

    // The user's devices, each with its own locale. Loaded once per store. If
    // empty, we still stamp every candidate below (no sends) so a later opt-in
    // doesn't replay history.
    const { data: subscriptions, error: subErr } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, locale')
      .eq('user_id', store.user_id);

    if (subErr) throw new Error(`load subscriptions: ${subErr.message}`);

    const subs = subscriptions ?? [];

    // Stable per-run suffix so two DIFFERENT runs' notifications for the same
    // store never collapse onto each other (they cover different orders), while
    // a duplicate delivery of the SAME push still dedups on this tag.
    const runStamp = Date.now();

    let deliveredTotal = 0;
    let failedTotal = 0;
    let processed = 0;
    const goneSubscriptionIds = new Set();
    const summaryParts = [];

    // NEW ORDERS — one notification.
    if (newIds.length > 0 && Date.now() < deadline) {
      if (subs.length > 0) {
        const r = await sendToSubscriptions(subs, (locale) =>
          newOrderPayload(storeName, newIds.length, locale, `new-orders-${store.id}-${runStamp}`)
        );
        deliveredTotal += r.delivered;
        failedTotal += r.failed;
        r.goneSubscriptionIds.forEach((id) => goneSubscriptionIds.add(id));
      }
      // Stamp the whole batch regardless of delivery / absence of devices.
      await stampNotifiedBatch(newIds, 'notified_new_at');
      processed += newIds.length;
      summaryParts.push(`${newIds.length} new order(s)`);
    }

    // CANCELLATION REQUESTS — one notification.
    if (cancelIds.length > 0 && Date.now() < deadline) {
      if (subs.length > 0) {
        const r = await sendToSubscriptions(subs, (locale) =>
          cancelPayload(storeName, cancelIds.length, locale, `cancel-${store.id}-${runStamp}`)
        );
        deliveredTotal += r.delivered;
        failedTotal += r.failed;
        r.goneSubscriptionIds.forEach((id) => goneSubscriptionIds.add(id));
      }
      await stampNotifiedBatch(cancelIds, 'notified_cancel_at');
      processed += cancelIds.length;
      summaryParts.push(`${cancelIds.length} cancellation(s)`);
    }

    // Purge dead endpoints once, after both batches.
    await deleteSubscriptions(goneSubscriptionIds);

    if (summaryParts.length === 0) {
      // Deadline hit before either batch could run — leave markers NULL so the
      // orders are retried (still once-only) next run.
      await logSyncComplete(logId, 'success', 'No time budget to notify this run');
      return { storeId: store.id, sent: 0 };
    }

    const summary =
      `${summaryParts.join(', ')} to ${subs.length} device(s): ` +
      `${deliveredTotal} delivered, ${failedTotal} failed` +
      (goneSubscriptionIds.size ? `, ${goneSubscriptionIds.size} expired removed` : '');

    // Delivery failures are a warning-level result, not a hard error, so the
    // store's sync isn't marked failed — but they're never silent.
    await logSyncComplete(logId, failedTotal > 0 ? 'warning' : 'success', summary);
    console.log(`[push] [${store.id}] ${summary}`);

    return { storeId: store.id, sent: processed, delivered: deliveredTotal, failed: failedTotal };
  } catch (err) {
    await logSyncComplete(logId, 'error', err.message);
    console.error(`[push] [${store.id}] notify failed`, err);
    // Swallow — a push failure must never break the store's order/product sync.
    return { storeId: store.id, sent: 0, error: err.message };
  }
}
