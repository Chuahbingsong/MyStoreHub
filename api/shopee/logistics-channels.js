import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { ensureFreshToken } from '../_lib/shopeeShip.js';
import { acquireSyncLock, logSyncStart, logSyncComplete } from '../_lib/shopeeSync.js';
import {
  getChannelList,
  updateChannel,
  buildChannelTree,
  mergeTrees,
  indexChannels,
  diffChannelStates,
  ShopeeLogisticsError,
} from '../_lib/shopeeLogistics.js';
import { withCors } from '../_lib/cors.js';

// Shop-level courier on/off, for the Shipping page.
//
//   GET  — live channel state for every connected store, merged into one grid.
//          Never cached: Shopee is the only source of truth for `enabled`.
//   POST — toggle ONE channel on ONE store, then prove it took.
//
// This is the second endpoint in the app that writes to Shopee (the first is
// copy-flash-sale.js). It changes what buyers see at checkout on live stores,
// immediately, so it carries the same read-back discipline: never trust the
// write's own response, re-read the world and report what's actually true.

export const config = { maxDuration: 30 };

const SYNC_TYPE = 'logistics_channel';

async function authenticate(req, res) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    console.error('[logistics-channels] auth verification failed', error);
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }

  return user;
}

async function loadStores(userId) {
  const { data, error } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', 'shopee')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) throw new Error('Failed to load stores');
  return data ?? [];
}

async function handleGet(req, res, user) {
  const stores = await loadStores(user.id);
  if (stores.length === 0) {
    return res.status(200).json({ success: true, stores: [], groups: [], fetchedAt: new Date().toISOString() });
  }

  const storeMeta = [];
  const perStore = [];

  // Sequential, not parallel: each store may trigger a token refresh, and two
  // concurrent refreshes for the same user race on the stores row. Four shops
  // at ~1 call each is well inside maxDuration.
  for (const store of stores) {
    try {
      const fresh = await ensureFreshToken(store);
      const raw = await getChannelList(fresh);
      perStore.push({ storeId: store.id, tree: buildChannelTree(raw) });
      storeMeta.push({ id: store.id, shopName: store.shop_name, shopId: store.shop_id, ok: true, error: null });
    } catch (err) {
      console.error('[logistics-channels] failed to load channels for store', store.id, err.message);
      storeMeta.push({
        id: store.id,
        shopName: store.shop_name,
        shopId: store.shop_id,
        ok: false,
        error: err.message || 'Failed to load channels',
      });
    }
  }

  return res.status(200).json({
    success: true,
    stores: storeMeta,
    groups: mergeTrees(perStore),
    fetchedAt: new Date().toISOString(),
  });
}

async function handlePost(req, res, user) {
  const { store_id, logistics_channel_id, enabled } = req.body ?? {};

  if (!store_id || logistics_channel_id === undefined || typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'store_id, logistics_channel_id and enabled (boolean) are required',
    });
  }

  const channelId = Number(logistics_channel_id);
  if (!Number.isFinite(channelId)) {
    return res.status(400).json({ success: false, error: 'logistics_channel_id must be a number' });
  }

  const { data: store, error: storeError } = await supabaseAdmin
    .from('stores')
    .select('*')
    .eq('id', store_id)
    .eq('platform', 'shopee')
    .maybeSingle();

  if (storeError) {
    console.error('[logistics-channels] failed to load store', storeError);
    return res.status(500).json({ success: false, error: 'Failed to load store' });
  }
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (store.user_id !== user.id) return res.status(403).json({ success: false, error: 'Forbidden' });

  // One toggle per store at a time. Two concurrent writes would interleave
  // their before-snapshots and each attribute the other's cascade to itself.
  const free = await acquireSyncLock(store.id, SYNC_TYPE);
  if (!free) {
    return res.status(409).json({
      success: false,
      reason: 'locked',
      error: 'Another shipping change is in flight for this store. Try again in a moment.',
    });
  }

  const logId = await logSyncStart(store.id, SYNC_TYPE);

  const audit = {
    store_id: store.id,
    logistics_channel_id: channelId,
    logistics_channel_name: null,
    requested_enabled: enabled,
    before_enabled: null,
    after_enabled: null,
    confirmed: false,
    collateral: [],
    shopee_error: null,
    actor_user_id: user.id,
  };

  const finish = async (status, message) => {
    await logSyncComplete(logId, status, message);
    const { error } = await supabaseAdmin.from('logistics_channel_audit').insert(audit);
    if (error) {
      // Non-fatal: the sync_logs row above already records the attempt, and
      // failing the seller's toggle because an audit insert failed would be
      // worse than a gap in the richer trail.
      console.error('[logistics-channels] failed to write audit row', error);
    }
  };

  let fresh;
  let beforeRaw;

  try {
    fresh = await ensureFreshToken(store);
    beforeRaw = await getChannelList(fresh);
  } catch (err) {
    audit.shopee_error = `before-snapshot failed: ${err.message}`;
    await finish('error', audit.shopee_error);
    return res.status(502).json({ success: false, error: `Could not read current state: ${err.message}` });
  }

  const before = indexChannels(beforeRaw);
  const target = before.get(channelId);

  if (!target) {
    audit.shopee_error = 'channel not found for this shop';
    await finish('error', audit.shopee_error);
    return res.status(404).json({ success: false, error: 'That courier is not available for this store.' });
  }

  audit.logistics_channel_name = target.name;
  audit.before_enabled = target.enabled;

  // Server-side enforcement of the same locks the UI renders. The UI can be
  // stale or bypassed; this is the check that actually holds.
  if (target.locked) {
    const reason =
      target.lockReason === 'parent'
        ? 'Shipping-option groups are managed in Shopee Seller Centre, not here.'
        : 'Shopee does not allow this courier to be changed.';
    audit.shopee_error = `locked: ${target.lockReason}`;
    await finish('skipped', audit.shopee_error);
    return res.status(409).json({ success: false, reason: 'locked', lockReason: target.lockReason, error: reason });
  }

  if (target.enabled === enabled) {
    audit.after_enabled = target.enabled;
    audit.confirmed = true;
    await finish('success', `no-op: already ${enabled ? 'enabled' : 'disabled'}`);
    return res.status(200).json({
      success: true,
      confirmed: true,
      noop: true,
      channel: { logisticsChannelId: channelId, name: target.name, enabled: target.enabled },
      collateral: [],
      tree: buildChannelTree(beforeRaw),
    });
  }

  // ---- the write ----
  let writeError = null;
  try {
    // codEnabled echoed from the before-snapshot: update_channel replaces the
    // channel's config wholesale, so omitting it would switch COD off.
    await updateChannel(fresh, channelId, { enabled, codEnabled: target.codEnabled });
  } catch (err) {
    writeError = err;
    console.error('[logistics-channels] update_channel failed', err.message);
  }

  // ---- the read-back ----
  // Runs even when the write threw: a failed write may still have partially
  // applied, and the seller needs the real state either way. Shopee's own
  // update_channel response is never used to decide `confirmed`.
  let afterRaw = null;
  let readBackError = null;
  try {
    afterRaw = await getChannelList(fresh);
  } catch (err) {
    readBackError = err;
    console.error('[logistics-channels] read-back failed', err.message);
  }

  if (!afterRaw) {
    audit.shopee_error = `write ${writeError ? 'failed' : 'sent'}, read-back failed: ${readBackError.message}`;
    await finish('error', audit.shopee_error);
    return res.status(502).json({
      success: false,
      unverified: true,
      error:
        'The change was sent but could not be verified — Shopee did not respond to the read-back. Reload before changing anything else.',
    });
  }

  const after = indexChannels(afterRaw);
  const afterTarget = after.get(channelId);
  const afterEnabled = afterTarget ? afterTarget.enabled : null;

  const allChanges = diffChannelStates(beforeRaw, afterRaw);
  const collateral = allChanges.filter((c) => c.logistics_channel_id !== channelId);

  audit.after_enabled = afterEnabled;
  audit.confirmed = afterEnabled === enabled;
  audit.collateral = collateral;
  if (writeError) audit.shopee_error = writeError.message;

  const summary = JSON.stringify({
    channel: { id: channelId, name: target.name },
    requested: enabled,
    before: target.enabled,
    after: afterEnabled,
    confirmed: audit.confirmed,
    collateral,
    ...(writeError ? { write_error: writeError.message } : {}),
  });

  await finish(audit.confirmed ? 'success' : 'error', summary);

  if (writeError && !audit.confirmed) {
    return res.status(502).json({
      success: false,
      confirmed: false,
      error: writeError.message || 'Shopee rejected the change.',
      shopeeResponse: writeError instanceof ShopeeLogisticsError ? writeError.shopeeResponse : null,
      channel: { logisticsChannelId: channelId, name: target.name, enabled: afterEnabled },
      collateral,
      tree: buildChannelTree(afterRaw),
    });
  }

  return res.status(200).json({
    success: true,
    // False here means Shopee accepted the call and did NOT apply it — the
    // single most important thing this endpoint can tell the seller.
    confirmed: audit.confirmed,
    channel: { logisticsChannelId: channelId, name: target.name, enabled: afterEnabled },
    requested: enabled,
    collateral,
    tree: buildChannelTree(afterRaw),
  });
}

export default withCors(handler);

async function handler(req, res) {
  const user = await authenticate(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') return await handleGet(req, res, user);
    if (req.method === 'POST') return await handlePost(req, res, user);
  } catch (err) {
    console.error('[logistics-channels] unhandled error', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
