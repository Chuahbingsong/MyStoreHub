import webpush from 'web-push';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from './shopeeSync.js';

// Server-side Web Push sender, run from the cron path (api/cron/sync-all.js)
// after a store's orders have been synced into Supabase. Sends at most one
// notification, ever, per order per event — dedup is enforced by the persisted
// marker columns orders.notified_new_at / notified_cancel_at (same "touch once"
// pattern as auto_pack_status), NEVER in-memory state.

// Shopee order_status values that count as "a new, actionable order" — the ones
// that land in the Orders page "New Orders" tab. UNPAID is deliberately
// excluded: an order sitting unpaid isn't yet something to act on, and would
// fire a false alarm for carts that may never be paid. An order first seen as
// UNPAID stays un-notified (marker NULL) until it flips into one of these.
const NEW_ORDER_STATUSES = ['READY_TO_SHIP', 'INVOICE_PENDING'];

// Cap how many orders one store's run notifies, so a backlog (or a bug) can't
// fire dozens of pushes or blow the shared cron time budget in a single tick.
const MAX_NOTIFY_PER_RUN = 20;

// True once configured — cached across warm invocations. Missing keys is a
// configuration error, not a per-order one: log once and skip, never throw
// (a throw here would break the whole store's sync).
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

// A short, human-readable order reference for the notification body. Shopee's
// order_sn is long; the buyer name (when present) is what a seller recognises.
function orderLabel(order) {
  if (order.buyer_name) return order.buyer_name;
  return order.platform_order_id;
}

function buildNewOrderPayload(order) {
  return {
    title: 'New order 🛒',
    body: `New order from ${orderLabel(order)} — tap to pack.`,
    url: '/orders?tab=new',
    // Per-order tag: collapses any duplicate delivery of the same event into
    // one notification instead of stacking.
    tag: `new-order-${order.id}`,
    requireInteraction: true,
  };
}

function buildCancelPayload(order) {
  return {
    title: 'Cancellation request ⏳',
    body: `${orderLabel(order)} requested to cancel — 48h to respond.`,
    url: '/orders?tab=cancelRequests',
    tag: `cancel-${order.id}`,
    requireInteraction: true,
  };
}

// Sends one payload to every subscription for the user. Returns the set of
// subscription ids whose endpoint is gone (HTTP 410/404) so the caller can
// delete them — a dead device must not error every cycle forever.
async function sendToSubscriptions(subscriptions, payload) {
  const body = JSON.stringify(payload);
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
        body
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
    // 410 Gone / 404 Not Found = the subscription is permanently invalid
    // (uninstalled PWA, cleared browser data, expired). Mark for deletion.
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

// Stamps one order's marker column so it is never notified for this event
// again — called AFTER the send attempt, and stamped regardless of per-device
// delivery success. A transient delivery failure must not cause a re-notify
// next tick (that's the "spammed every 5 minutes" failure mode); the failure
// is surfaced in sync_logs / console instead of retried.
async function stampNotified(orderId, column) {
  const { error } = await supabaseAdmin
    .from('orders')
    .update({ [column]: new Date().toISOString() })
    .eq('id', orderId);
  if (error) {
    console.error(`[push] failed to stamp ${column} on order`, orderId, error);
  }
}

/**
 * Notifies a store's owner about newly-actionable orders and buyer cancellation
 * requests. Shares the caller's per-store deadline — it never gets a fresh time
 * window — and is a no-op cost when the user has no push subscriptions (every
 * candidate is still stamped so enabling push later doesn't blast history).
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
  // before the marker is stamped.
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
      .select('id, platform_order_id, buyer_name, order_status')
      .eq('store_id', store.id)
      .is('notified_new_at', null)
      .in('order_status', NEW_ORDER_STATUSES)
      .order('order_created_at', { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN);

    if (newErr) throw new Error(`load new-order candidates: ${newErr.message}`);

    // Buyer-initiated cancellation requests: never notified, still in flight.
    const { data: cancelOrders, error: cancelErr } = await supabaseAdmin
      .from('orders')
      .select('id, platform_order_id, buyer_name, cancel_by')
      .eq('store_id', store.id)
      .is('notified_cancel_at', null)
      .eq('order_status', 'IN_CANCEL')
      .eq('cancel_by', 'buyer')
      .order('order_created_at', { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN);

    if (cancelErr) throw new Error(`load cancel candidates: ${cancelErr.message}`);

    const candidates = [
      ...(newOrders ?? []).map((o) => ({ order: o, kind: 'new' })),
      ...(cancelOrders ?? []).map((o) => ({ order: o, kind: 'cancel' })),
    ].slice(0, MAX_NOTIFY_PER_RUN);

    if (candidates.length === 0) {
      await logSyncComplete(logId, 'success', 'No orders to notify');
      return { storeId: store.id, sent: 0 };
    }

    // The user's devices. Loaded once per store. If empty, we still stamp every
    // candidate below (no sends) so a later opt-in doesn't replay history.
    const { data: subscriptions, error: subErr } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', store.user_id);

    if (subErr) throw new Error(`load subscriptions: ${subErr.message}`);

    const subs = subscriptions ?? [];

    let sent = 0;
    let processed = 0;
    let deliveredTotal = 0;
    let failedTotal = 0;
    const goneSubscriptionIds = new Set();

    for (const { order, kind } of candidates) {
      // Stop starting new sends once out of budget; unprocessed candidates keep
      // their NULL marker and are retried next run.
      if (Date.now() >= deadline) {
        console.warn(
          `[push] [${store.id}] time budget reached, stopping after ${processed}/${candidates.length}`
        );
        break;
      }

      const column = kind === 'new' ? 'notified_new_at' : 'notified_cancel_at';
      const payload = kind === 'new' ? buildNewOrderPayload(order) : buildCancelPayload(order);

      if (subs.length > 0) {
        const result = await sendToSubscriptions(subs, payload);
        deliveredTotal += result.delivered;
        failedTotal += result.failed;
        result.goneSubscriptionIds.forEach((id) => goneSubscriptionIds.add(id));
        if (result.delivered > 0) sent += 1;
      }

      // Stamp regardless of delivery outcome (or absence of devices) — the
      // notification decision for this order is now final.
      await stampNotified(order.id, column);
      processed += 1;
    }

    // Purge dead endpoints once, after the loop.
    await deleteSubscriptions(goneSubscriptionIds);

    const summary =
      `Processed ${processed} order(s) for ${subs.length} device(s): ` +
      `${deliveredTotal} delivered, ${failedTotal} failed` +
      (goneSubscriptionIds.size ? `, ${goneSubscriptionIds.size} expired removed` : '');

    // Delivery failures are a warning-level result, not a hard error, so the
    // store's sync isn't marked failed — but they're never silent.
    await logSyncComplete(logId, failedTotal > 0 ? 'warning' : 'success', summary);
    console.log(`[push] [${store.id}] ${summary}`);

    return { storeId: store.id, sent, processed, delivered: deliveredTotal, failed: failedTotal };
  } catch (err) {
    await logSyncComplete(logId, 'error', err.message);
    console.error(`[push] [${store.id}] notify failed`, err);
    // Swallow — a push failure must never break the store's order/product sync.
    return { storeId: store.id, sent: 0, error: err.message };
  }
}
