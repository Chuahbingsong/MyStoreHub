import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete, ensureFreshToken } from './shopeeSync.js';

// Auto-boost: re-boosts a store's product rotation into its 5 Shopee boost
// slots every ~4h. Runs last in the cron per-store pipeline (after orders,
// products, auto-pack), sharing the same deadline — it never gets a fresh time
// window of its own.
//
// TIMING MODEL (verified live against the Kardon shop, 2026-07-23):
// get_boosted_list returns each boosted item as { item_id, cool_down_second },
// where cool_down_second is a live countdown that decrements exactly 1:1 with
// wall-clock time (observed 2684 -> 2384 over 300s, all 5 items in lockstep).
// An item is re-boostable when it is EITHER absent from the list OR present
// with cool_down_second <= 0. We do NOT observe the exact zero-crossing, so
// this "absent OR <= 0" test is deliberately correct under both possible
// zero-behaviours (item drops out of the list vs. lingers at 0).
//
// EXCLUSIVE CONTROL, defensively: auto_boost_enabled means MyStore Hub owns
// this store's 5 slots. But we NEVER assume we're the only booster — if
// get_boosted_list shows any occupied slot holding an item that is not in our
// rotation, another booster (e.g. BigSeller left on) is active, so we log a
// warning and skip the cycle rather than interleave and fight over slots.

const BOOST_MAX_SLOTS = 5;

// A slot counts as occupied/locked only while its item still has time on the
// clock. At or below this threshold the item is re-boostable (see timing note).
const REBOOST_THRESHOLD_SECONDS = 0;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * GET /api/v2/product/get_boosted_list — the store's currently-boosted items.
 * Returns [{ item_id: number, cool_down_second: number }].
 */
async function getBoostedList(store) {
  const path = '/api/v2/product/get_boosted_list';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: String(store.shop_id),
    sign,
  });

  const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[auto-boost] get_boosted_list failed', data);
    throw new Error(data.message || data.error || 'Failed to fetch boosted list');
  }

  return data.response?.item_list ?? [];
}

/**
 * POST /api/v2/product/boost_item — boosts up to 5 items in one call. Common
 * params go in the query string, the item list in the JSON body (v2
 * convention). Returns the raw Shopee response for logging; SUCCESS IS NOT
 * INFERRED FROM THIS RESPONSE — the caller verifies via a get_boosted_list
 * re-poll instead (see boostAndVerify), so a partial/empty/misshaped response
 * can never be silently counted as a boost.
 */
async function boostItem(store, itemIdList) {
  const path = '/api/v2/product/boost_item';
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: String(store.shop_id),
    sign,
  });

  const url = `${SHOPEE_API_BASE}${path}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id_list: itemIdList }),
  });
  const data = await response.json();

  // A non-empty top-level error means the WHOLE call was rejected (bad token,
  // wrong param name, out-of-scope, etc). Surface it — this is the only
  // response-derived failure we treat as fatal; per-item outcomes are decided
  // by the re-poll below, never guessed from this body's shape.
  if (!response.ok || data.error) {
    console.error('[auto-boost] boost_item call rejected', data);
    throw new Error(data.message || data.error || 'boost_item call rejected');
  }

  return data;
}

// Snapshot the store's live boosted set into boost_slots for the UI. Rewrites
// the store's rows each cycle: upsert what's currently boosted, delete rows for
// items no longer in the list. observedAt anchors the absolute reboostable_at
// so the UI can count down without re-polling.
async function snapshotBoostSlots(storeId, boostedList, productIdByItemId, rotationItemIds, observedAt) {
  const rows = boostedList.map((b) => {
    const itemId = String(b.item_id);
    const cool = b.cool_down_second ?? 0;
    return {
      store_id: storeId,
      item_id: itemId,
      product_id: productIdByItemId.get(itemId) ?? null,
      cool_down_second: cool,
      reboostable_at: new Date(observedAt + cool * 1000).toISOString(),
      externally_controlled: cool > REBOOST_THRESHOLD_SECONDS && !rotationItemIds.has(itemId),
      observed_at: new Date(observedAt).toISOString(),
    };
  });

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from('boost_slots')
      .upsert(rows, { onConflict: 'store_id,item_id' });
    if (error) console.error('[auto-boost] failed to upsert boost_slots snapshot', storeId, error);
  }

  // Delete rows for items no longer boosted so the snapshot doesn't accrue
  // stale slots. Nothing currently boosted => clear them all.
  const keepItemIds = rows.map((r) => r.item_id);
  let del = supabaseAdmin.from('boost_slots').delete().eq('store_id', storeId);
  if (keepItemIds.length > 0) {
    del = del.not('item_id', 'in', `(${keepItemIds.join(',')})`);
  }
  const { error: delError } = await del;
  if (delError) console.error('[auto-boost] failed to prune stale boost_slots', storeId, delError);
}

/**
 * Auto-boosts one store. Mirrors autoPackStore's contract: opt-in per store,
 * acquireSyncLock keyed on store.id, sync_logs started/completed bookkeeping
 * (including the timeout-visible 'started'-with-no-completion signature), and a
 * shared caller deadline it must not exceed.
 *
 * options.deadline: shares the caller's per-store time budget — no fresh window.
 */
export async function autoBoostStore(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;

  const canProceed = await acquireSyncLock(store.id, 'auto_boost');
  if (!canProceed) {
    console.log(`[auto-boost] [${store.id}] already in progress elsewhere, skipping`);
    return { storeId: store.id, boosted: 0, locked: true };
  }

  const logId = await logSyncStart(store.id, 'auto_boost');

  try {
    const freshStore = await ensureFreshToken(store);

    // Map this store's Shopee item_id -> our product uuid, for slot linkage and
    // for recognising which boosted items are "ours". A boosted item_id absent
    // from this map is one we've never synced (definitely external).
    const { data: products, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, platform_product_id')
      .eq('store_id', store.id);
    if (productsError) throw new Error(`failed to load products: ${productsError.message}`);

    const productIdByItemId = new Map(
      (products ?? []).map((p) => [String(p.platform_product_id), p.id])
    );

    // The rotation, joined to products so we know each entry's Shopee item_id.
    const { data: rotationRows, error: rotationError } = await supabaseAdmin
      .from('boost_rotation')
      .select('id, product_id, position, last_boosted_at, products(platform_product_id)')
      .eq('store_id', store.id);
    if (rotationError) throw new Error(`failed to load rotation: ${rotationError.message}`);

    const rotation = (rotationRows ?? [])
      .map((r) => ({
        rotationId: r.id,
        productId: r.product_id,
        itemId: r.products?.platform_product_id != null ? String(r.products.platform_product_id) : null,
        position: r.position ?? 0,
        lastBoostedAt: r.last_boosted_at ? new Date(r.last_boosted_at).getTime() : 0,
      }))
      .filter((r) => r.itemId); // drop entries whose product row/item_id is missing
    const rotationItemIds = new Set(rotation.map((r) => r.itemId));

    const observedAt = Date.now();
    const boosted = await getBoostedList(freshStore);
    await snapshotBoostSlots(store.id, boosted, productIdByItemId, rotationItemIds, observedAt);

    const occupied = boosted.filter((b) => (b.cool_down_second ?? 0) > REBOOST_THRESHOLD_SECONDS);
    const occupiedItemIds = new Set(occupied.map((b) => String(b.item_id)));

    // DEFENSIVE: any occupied slot holding a non-rotation item => another
    // booster is active. Warn and skip rather than fight over slots.
    const external = occupied.filter((b) => !rotationItemIds.has(String(b.item_id)));
    if (external.length > 0) {
      const ids = external.map((b) => b.item_id).join(', ');
      const msg = `skipped: ${external.length} slot(s) controlled externally (item_id: ${ids}) — not fighting another booster`;
      console.warn(`[auto-boost] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, boosted: 0, skipped: 'external', external: external.length };
    }

    const freeSlots = BOOST_MAX_SLOTS - occupied.length;
    if (freeSlots <= 0) {
      const msg = `all ${occupied.length} slot(s) still active, nothing to re-boost`;
      console.log(`[auto-boost] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, boosted: 0, freeSlots: 0 };
    }

    if (rotation.length === 0) {
      const msg = 'no products in rotation — enable stores in the Boost page to populate it';
      console.log(`[auto-boost] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, boosted: 0, freeSlots };
    }

    // Candidates: rotation items NOT already boosted (can't re-boost a cooling
    // item), least-recently-boosted first (fair rotation), position as a
    // stable tiebreaker. Take only as many as there are free slots.
    const candidates = rotation
      .filter((r) => !occupiedItemIds.has(r.itemId))
      .sort((a, b) => a.lastBoostedAt - b.lastBoostedAt || a.position - b.position)
      .slice(0, freeSlots);

    if (candidates.length === 0) {
      const msg = `${freeSlots} free slot(s) but no eligible rotation product (all currently cooling)`;
      console.log(`[auto-boost] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, boosted: 0, freeSlots };
    }

    if (Date.now() >= deadline) {
      const msg = 'time budget reached before boosting, deferring to next cycle';
      console.warn(`[auto-boost] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, boosted: 0, deferred: true };
    }

    const candidateItemIds = candidates.map((c) => Number(c.itemId));
    console.log(`[auto-boost] [${store.id}] boosting ${candidateItemIds.length} item(s):`, candidateItemIds.join(', '));

    const rawResp = await boostItem(freshStore, candidateItemIds);
    // Log the raw response verbatim — if boost_item's per-item failure_list
    // shape differs in production, it's captured here rather than guessed at.
    console.log(`[auto-boost] [${store.id}] boost_item raw response:`, JSON.stringify(rawResp));

    // VERIFY, don't assume: re-poll get_boosted_list. An intended item counts
    // as boosted ONLY if it now appears with cool_down_second > 0. This is the
    // single source of truth for success — no reliance on boost_item's response
    // shape, so an empty/partial response can never be mistaken for success.
    const verifyAt = Date.now();
    const boostedAfter = await getBoostedList(freshStore);
    await snapshotBoostSlots(store.id, boostedAfter, productIdByItemId, rotationItemIds, verifyAt);

    const confirmedItemIds = new Set(
      boostedAfter
        .filter((b) => (b.cool_down_second ?? 0) > REBOOST_THRESHOLD_SECONDS)
        .map((b) => String(b.item_id))
    );

    const confirmed = [];
    const unconfirmed = [];
    for (const c of candidates) {
      if (confirmedItemIds.has(c.itemId)) confirmed.push(c);
      else unconfirmed.push(c);
    }

    // Stamp last_boosted_at ONLY on confirmed items, so an unconfirmed one
    // stays at the front of the fair-rotation queue and is retried next cycle
    // rather than being skipped as if it had boosted.
    if (confirmed.length > 0) {
      const nowIso = new Date().toISOString();
      const { error: stampError } = await supabaseAdmin
        .from('boost_rotation')
        .update({ last_boosted_at: nowIso })
        .in('id', confirmed.map((c) => c.rotationId));
      if (stampError) console.error('[auto-boost] failed to stamp last_boosted_at', store.id, stampError);
    }

    // Per-item failures are enumerated in the completion message (and warned to
    // the console) — never silently swallowed. A rotation product that simply
    // can't be boosted (out of stock, delisted) will keep surfacing here, which
    // is the intended signal to remove it from the rotation.
    if (unconfirmed.length > 0) {
      const ids = unconfirmed.map((c) => c.itemId).join(', ');
      console.warn(`[auto-boost] [${store.id}] ${unconfirmed.length} item(s) NOT confirmed boosted: ${ids}`);
    }

    const status = confirmed.length === 0 ? 'error' : 'success';
    const msg =
      `boosted ${confirmed.length}/${candidates.length} into ${freeSlots} free slot(s)` +
      (unconfirmed.length > 0 ? `; UNCONFIRMED item_id: ${unconfirmed.map((c) => c.itemId).join(', ')}` : '');
    await logSyncComplete(logId, status, msg);
    console.log(`[auto-boost] [${store.id}] done: ${msg}`);

    return {
      storeId: store.id,
      boosted: confirmed.length,
      attempted: candidates.length,
      unconfirmed: unconfirmed.length,
      freeSlots,
    };
  } catch (err) {
    console.error(`[auto-boost] [${store.id}] failed:`, err.message);
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}
