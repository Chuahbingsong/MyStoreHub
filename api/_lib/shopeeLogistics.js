import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';

// Shop-level logistics channel preferences — which couriers a store offers at
// checkout. Backs the Shipping page (src/pages/Shipping.jsx).
//
// Two Shopee endpoints:
//   /api/v2/logistics/get_channel_list  — read,  24 channels per MY shop
//   /api/v2/logistics/update_channel    — write, one channel at a time
//
// `preferred` is deliberately never sent. update_channel accepts it, but
// get_channel_list does NOT return it (verified across all 96 channel objects
// on all 4 live shops — the response has enabled/cod_enabled/force_enable/
// compulsory_channel and no `preferred` key at all). A value we can write but
// can never read back is a value we can never confirm, and confirming writes
// is this module's whole job. So it stays out.

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

/** Mirrors ShopeeStepError in shopeeShip.js — carries Shopee's own body up. */
export class ShopeeLogisticsError extends Error {
  constructor(step, message, shopeeResponse) {
    super(message);
    this.name = 'ShopeeLogisticsError';
    this.step = step;
    this.shopeeResponse = shopeeResponse ?? null;
  }
}

async function shopeeJsonCall(step, url, init) {
  let response;
  let bodyText;

  try {
    response = await fetch(url, init);
    bodyText = await response.text();
  } catch (err) {
    console.error(`[shopee-logistics] ${step}: network error`, err.message);
    throw new ShopeeLogisticsError(step, `Network error calling Shopee (${step}): ${err.message}`, null);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { _unparsed_body: bodyText };
  }

  if (!response.ok || data.error) {
    console.error(`[shopee-logistics] ${step}: HTTP ${response.status}`, JSON.stringify(data));
    throw new ShopeeLogisticsError(step, data.message || `Shopee call failed: ${step}`, data);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Shopee calls
// ---------------------------------------------------------------------------

/** Raw, unfiltered channel list for one shop. */
export async function getChannelList(store) {
  const url = buildSignedUrl('/api/v2/logistics/get_channel_list', store);
  const data = await shopeeJsonCall('get_channel_list', url);
  return data.response?.logistics_channel_list ?? [];
}

/**
 * Flips one channel. Shopee's update_channel replaces the channel's whole
 * config, so cod_enabled must be echoed back at its CURRENT value or COD
 * would be silently switched off as a side effect of a pure enable/disable.
 * The caller passes the value it read in the same before-snapshot it used to
 * validate the request.
 */
export async function updateChannel(store, logisticsChannelId, { enabled, codEnabled }) {
  const url = buildSignedUrl('/api/v2/logistics/update_channel', store);

  const body = {
    logistics_channel_id: Number(logisticsChannelId),
    enabled: Boolean(enabled),
    cod_enabled: Boolean(codEnabled),
  };

  console.log('[shopee-logistics] update_channel request:', JSON.stringify(body));

  return shopeeJsonCall('update_channel', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Taxonomy — turning Shopee's flat 24-row list into the BigSeller hierarchy
// ---------------------------------------------------------------------------

// Brunei. `2200` is the mask parent, `26002` its only child; excluding the
// parent id excludes both, since children are dropped with their parent.
// Everything else Shopee returns for a MY shop is MY-relevant.
const EXCLUDED_MASK_CHANNEL_IDS = new Set([2200]);

/**
 * True for routes this seller never uses. Kept as a function (rather than a
 * hardcoded id list) so a channel Shopee adds later is excluded on its own
 * merits instead of silently appearing in a MY-only grid.
 */
function isExcluded(channel) {
  if (EXCLUDED_MASK_CHANNEL_IDS.has(channel.logistics_channel_id)) return true;
  if (EXCLUDED_MASK_CHANNEL_IDS.has(channel.mask_channel_id)) return true;
  if (channel.support_cross_border === true) return true;
  return false;
}

/** Ids that other channels hang off. These are the lockable mask parents. */
function parentIdsOf(channels) {
  const ids = new Set();
  for (const c of channels) {
    if (c.mask_channel_id) ids.add(c.mask_channel_id);
  }
  return ids;
}

function hasRelationRules(channel) {
  const r = channel.channel_relation_rules ?? {};
  return (
    (r.related_enabled_channels?.length ?? 0) > 0 ||
    (r.related_disabled_channels?.length ?? 0) > 0 ||
    (r.related_dependent_block_channels?.length ?? 0) > 0
  );
}

/**
 * Collapses one shop's raw list into unique channels keyed by
 * logistics_channel_id.
 *
 * Shopee returns some channels TWICE: on every one of the 4 live shops,
 * BEST Cargo (20103) and SPX Express (Bulky) (20204) each appear under BOTH
 * mask 2000 (Doorstep Delivery) and mask 2100 (Bulky Delivery), always with
 * identical `enabled`. They are ONE underlying channel surfaced under two
 * parents — update_channel(20103, …) moves both rows at once. Rendering two
 * independently-togglable rows would let the UI show a channel as on under
 * one parent and off under the other, which can never be true.
 *
 * So: one row per id, filed under a single primary parent, with the other
 * parents recorded in `alsoUnderMaskIds` for display.
 *
 * (Note the converse case, which does NOT collapse: "SPX Express (Sea
 * Shipping)" is genuinely TWO channels, 20077 and 20078, both under mask
 * 2001. Same name, different ids, independently togglable. Keying on id
 * rather than name is what keeps those two apart.)
 */
function dedupeById(channels) {
  const byId = new Map();

  for (const c of channels) {
    const existing = byId.get(c.logistics_channel_id);
    if (!existing) {
      byId.set(c.logistics_channel_id, { ...c, _maskIds: [c.mask_channel_id] });
      continue;
    }
    existing._maskIds.push(c.mask_channel_id);
    // Same id must mean same channel; if Shopee ever disagrees with itself on
    // `enabled` between two rows for one id, treat "off" as the truth rather
    // than showing a green toggle for a channel that may be half-off.
    if (existing.enabled && !c.enabled) existing.enabled = false;
  }

  return [...byId.values()];
}

/**
 * Builds the display tree for ONE shop.
 *
 * Locking policy (deliberate, see the cascade note below):
 *   - mask parents are ALWAYS locked. Only the 5 parents carry
 *     channel_relation_rules, and those rules are self-contradictory in
 *     Shopee's own data — e.g. Self Collection Point (20097) lists 20087 and
 *     2006 in BOTH related_enabled_channels and related_disabled_channels,
 *     and every rule set references ids (20099, 2006, 2007, 2201) that are
 *     not in the 24-channel list at all, so they cannot even be named. A
 *     parent toggle's blast radius is therefore unknowable in advance, and
 *     re-enabling a parent is not guaranteed to restore the children it took
 *     down. Parents stay read-only here; they're changed in Seller Centre.
 *   - compulsory_channel / force_enable lock an individual cell. Shopee will
 *     refuse those writes anyway; locking is honest about it up front.
 *
 * Standalone channels (Self Collection Point, Self Collection Locker, Instant
 * Delivery) have mask_channel_id 0 AND no children — they are couriers, not
 * parents, and they stay togglable even though two of them carry relation
 * rules. They're 24% of real order volume; locking them would gut the page.
 * Their rules are surfaced to the confirm dialog instead, and the post-write
 * diff catches any cascade they do cause.
 */
export function buildChannelTree(rawChannels) {
  const kept = rawChannels.filter((c) => !isExcluded(c));
  const parentIds = parentIdsOf(kept);
  const unique = dedupeById(kept);

  const isParent = (id) => parentIds.has(id);

  // Count how many unique children each parent would own, so a channel listed
  // under several parents lands under the most substantial one (Doorstep
  // Delivery, with 10, rather than Bulky Delivery, with 2). Deterministic:
  // ties break on the lower id, so the grid never reshuffles between loads.
  const childCount = new Map();
  for (const c of unique) {
    for (const maskId of c._maskIds) {
      if (!maskId) continue;
      childCount.set(maskId, (childCount.get(maskId) ?? 0) + 1);
    }
  }

  const primaryMaskOf = (c) => {
    const masks = c._maskIds.filter(Boolean);
    if (masks.length === 0) return 0;
    return masks.sort((a, b) => (childCount.get(b) ?? 0) - (childCount.get(a) ?? 0) || a - b)[0];
  };

  const toEntry = (c) => {
    const primaryMask = primaryMaskOf(c);
    const parent = isParent(c.logistics_channel_id);
    const compulsory = c.compulsory_channel === true;
    const forced = c.force_enable === true;

    return {
      logisticsChannelId: c.logistics_channel_id,
      name: c.logistics_channel_name || `Channel ${c.logistics_channel_id}`,
      enabled: c.enabled === true,
      codEnabled: c.cod_enabled === true,
      maskChannelId: primaryMask,
      alsoUnderMaskIds: [...new Set(c._maskIds.filter((m) => m && m !== primaryMask))],
      isParent: parent,
      locked: parent || compulsory || forced,
      lockReason: parent ? 'parent' : compulsory ? 'compulsory' : forced ? 'force_enabled' : null,
      hasRelationRules: hasRelationRules(c),
    };
  };

  const entries = unique.map(toEntry);
  const byId = new Map(entries.map((e) => [e.logisticsChannelId, e]));

  // Group children under their primary parent; parents themselves become the
  // group header rather than a row inside it.
  const groups = new Map();
  const ensureGroup = (maskId) => {
    if (!groups.has(maskId)) {
      const parentEntry = maskId ? byId.get(maskId) : null;
      groups.set(maskId, {
        maskChannelId: maskId,
        name: parentEntry?.name ?? null,
        parentEnabled: parentEntry ? parentEntry.enabled : null,
        parentLocked: true,
        parentHasRelationRules: parentEntry ? parentEntry.hasRelationRules : false,
        channels: [],
      });
    }
    return groups.get(maskId);
  };

  for (const e of entries) {
    if (e.isParent) {
      ensureGroup(e.logisticsChannelId); // header exists even with 0 children
      continue;
    }
    ensureGroup(e.maskChannelId).channels.push(e);
  }

  // Stable ordering: standalone couriers (mask 0) first — they include the
  // two biggest real channels — then parents by id.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.maskChannelId === 0) return -1;
    if (b.maskChannelId === 0) return 1;
    return a.maskChannelId - b.maskChannelId;
  });

  for (const g of ordered) {
    g.channels.sort((a, b) => a.name.localeCompare(b.name) || a.logisticsChannelId - b.logisticsChannelId);
  }

  return ordered;
}

/** Flat id -> entry map for one shop, used for validation and diffing. */
export function indexChannels(rawChannels) {
  const map = new Map();
  for (const g of buildChannelTree(rawChannels)) {
    if (g.maskChannelId) {
      // Parent rows are addressable too, so a toggle request naming a parent
      // is rejected as locked rather than as "not found".
      const parentRaw = rawChannels.find((c) => c.logistics_channel_id === g.maskChannelId);
      if (parentRaw) {
        map.set(g.maskChannelId, {
          logisticsChannelId: g.maskChannelId,
          name: parentRaw.logistics_channel_name,
          enabled: parentRaw.enabled === true,
          codEnabled: parentRaw.cod_enabled === true,
          locked: true,
          lockReason: 'parent',
          isParent: true,
        });
      }
    }
    for (const c of g.channels) map.set(c.logisticsChannelId, c);
  }
  return map;
}

/**
 * Merges each store's own tree into a single grid: one row per channel, one
 * cell per store. Built as a union rather than assuming every shop returns
 * the same 24 channels — they do today, but a channel Shopee offers one shop
 * and not another must render as an absent cell, never silently inherit a
 * neighbouring store's state.
 *
 * `perStore` is [{ storeId, tree }] with tree from buildChannelTree.
 */
export function mergeTrees(perStore) {
  const groups = new Map();

  const ensureGroup = (g) => {
    if (!groups.has(g.maskChannelId)) {
      groups.set(g.maskChannelId, {
        maskChannelId: g.maskChannelId,
        name: g.name,
        parentStates: {},
        parentHasRelationRules: false,
        channels: new Map(),
      });
    }
    const merged = groups.get(g.maskChannelId);
    if (!merged.name && g.name) merged.name = g.name;
    merged.parentHasRelationRules ||= g.parentHasRelationRules;
    return merged;
  };

  for (const { storeId, tree } of perStore) {
    for (const g of tree) {
      const merged = ensureGroup(g);
      merged.parentStates[storeId] = { enabled: g.parentEnabled };

      for (const c of g.channels) {
        if (!merged.channels.has(c.logisticsChannelId)) {
          merged.channels.set(c.logisticsChannelId, {
            logisticsChannelId: c.logisticsChannelId,
            name: c.name,
            alsoUnderMaskIds: c.alsoUnderMaskIds,
            hasRelationRules: c.hasRelationRules,
            states: {},
          });
        }
        const row = merged.channels.get(c.logisticsChannelId);
        row.hasRelationRules ||= c.hasRelationRules;
        row.states[storeId] = {
          present: true,
          enabled: c.enabled,
          codEnabled: c.codEnabled,
          locked: c.locked,
          lockReason: c.lockReason,
          // A child whose mask parent is off usually cannot be turned on:
          // Shopee accepts the write and quietly ignores it. Surfaced so the
          // confirm dialog warns up front instead of the read-back being the
          // first the seller hears of it.
          parentEnabled: g.parentEnabled,
        };
      }
    }
  }

  return [...groups.values()].map((g) => ({
    ...g,
    channels: [...g.channels.values()],
  }));
}

/**
 * The reason this module exists.
 *
 * Shopee's channel_relation_rules cannot be modelled (see buildChannelTree),
 * so nothing here tries to predict what a toggle will do. Instead the caller
 * snapshots the shop's FULL channel list before the write and re-fetches the
 * FULL list after, and this compares them. Anything that moved which the
 * seller did not click is collateral, and gets shown to them.
 *
 * Compares deduped entries, so the BEST Cargo / SPX Bulky double-listing
 * can't register as a phantom change.
 */
export function diffChannelStates(beforeRaw, afterRaw) {
  const before = indexChannels(beforeRaw);
  const after = indexChannels(afterRaw);

  const changes = [];
  const ids = new Set([...before.keys(), ...after.keys()]);

  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);

    const beforeEnabled = b ? b.enabled : null;
    const afterEnabled = a ? a.enabled : null;
    if (beforeEnabled === afterEnabled) continue;

    changes.push({
      logistics_channel_id: id,
      logistics_channel_name: a?.name ?? b?.name ?? `Channel ${id}`,
      before: beforeEnabled,
      after: afterEnabled,
    });
  }

  return changes.sort((x, y) => x.logistics_channel_id - y.logistics_channel_id);
}
