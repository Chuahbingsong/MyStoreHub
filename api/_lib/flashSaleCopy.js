import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { ensureFreshToken } from './shopeeSync.js';
import { flashSaleGet } from './flashSaleSync.js';
import { selectAllPaged } from './supabaseSelect.js';

// Flash Deals COPY — the only WRITE path to Shopee in this codebase.
//
// ============================ SHIPPED DISABLED =============================
// COPY_ENABLED is false. Every entrypoint refuses before touching Shopee.
// The reason is operational, not technical: on 2026-08-02 we are observing
// whether BigSeller overwrites a slot we already own (Big Hammer, flash sale
// 485935703994404, slot 481466245264485, 12:00-14:00 MYT). Until that race is
// understood, a working Copy could silently schedule deals that get replaced.
//
// Flipping this to true also requires flipping COPY_ENABLED in
// src/pages/FlashDeals.jsx — the UI keeps its own copy of the flag because the
// browser cannot import this module. They are meant to move together.
// ===========================================================================
//
// ENDPOINTS (verified live against Partner ID 2038912 on production,
// 2026-07-27, by an actual create+add on Big Hammer):
//   POST /api/v2/shop_flash_sale/create_shop_flash_sale
//        body { timeslot_id }  -> response { timeslot_id, flash_sale_id, status }
//        That is the WHOLE response. No echo of times, no item scaffolding.
//   POST /api/v2/shop_flash_sale/add_shop_flash_sale_items
//        body { flash_sale_id, items: [{ item_id, purchase_limit,
//               models: [{ model_id, input_promo_price, stock }] }] }
//        NOTE the plural name. add_shop_flash_sale_item (singular) is a 404 —
//        same doc-vs-reality gap as get_time_slot_id on the read side.
//
// ===================== WHY THE READ-BACK IS MANDATORY ======================
// add_shop_flash_sale_items returns an EMPTY BODY on success:
//     { "request_id": "...", "error": "", "message": "", "response": {} }
// There is no failed_items list, no per-model status, no partial-failure
// reporting of any kind. Success can NEVER be inferred from the write call —
// a half-applied write is indistinguishable from a clean one at that point.
// So every copy ends with a read-back and a full per-model diff, and anything
// short of an exact match is reported as PARTIAL, never as success.
//
// Verify against get_shop_flash_sale_ITEMS only, never get_shop_flash_sale:
// the session-level endpoint is eventually consistent and reported
// item_count=0 / enabled_item_count=0 for ~2 minutes after a write that the
// items endpoint had already confirmed as complete (observed live).
// ===========================================================================

export const COPY_ENABLED = false;

// Copy is a write and costs ~3 Shopee calls (create + add + read-back page).
// Tighter than the read-only per-slot sync's budget for that reason.
export const COPY_WINDOW_MS = 60_000;
export const COPY_MAX_PER_WINDOW = 3;

const READBACK_PAGE_LIMIT = 50; // same ceiling as the sync path

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signed POST against a shop_flash_sale endpoint. Mirrors flashSaleGet's
 * contract: common params on the query string, throws on a non-empty top-level
 * `error` so a rejected call can never be mistaken for a successful one.
 */
async function flashSalePost(store, path, body) {
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: String(store.shop_id),
    sign,
  });

  const response = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[flash-copy] call rejected', path, data);
    throw new Error(data.message || data.error || `${path} rejected`);
  }

  return data;
}

/**
 * Groups a source session's ENABLED models into the add_shop_flash_sale_items
 * payload shape, at IDENTICAL prices to the source.
 *
 * Copying prices unchanged is the case proven safe: across 554 repeated models
 * in the 7-day window, every single one held a flat promo price over up to 44
 * consecutive sessions, so re-running a price does not trip need_lowest_price.
 * A price the user has edited is NOT that proven case, which is why this
 * function has no price-override parameter.
 *
 * Disabled/rejected models are dropped — re-sending something Shopee already
 * refused just reproduces the refusal.
 */
export function buildCopyPayload(sourceItems) {
  const enabled = sourceItems.filter((i) => i.status === 1);
  const byItem = new Map();
  for (const m of enabled) {
    const key = String(m.item_id);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(m);
  }

  return [...byItem.entries()].map(([itemId, models]) => ({
    item_id: Number(itemId),
    purchase_limit: models[0].purchase_limit ?? 0,
    models: models.map((m) => ({
      model_id: Number(m.model_id),
      input_promo_price: Number(m.input_promotion_price),
      // campaign_stock is the ALLOCATED quota on the source, which is exactly
      // what `stock` means on the write side. It is not a remaining counter.
      stock: m.campaign_stock ?? 1,
    })),
  }));
}

/**
 * Pages get_shop_flash_sale_items for a freshly-written session. Separate from
 * the sync path's fetcher because this one only needs the model rows and must
 * page to completion — a short read here would be misreported as a partial
 * write.
 */
async function readBackModels(store, flashSaleId, { deadline }) {
  const models = [];
  const seenItems = new Set();
  let offset = 0;
  let totalCount = null;

  while (Date.now() < deadline) {
    const data = await flashSaleGet(store, '/api/v2/shop_flash_sale/get_shop_flash_sale_items', {
      flash_sale_id: flashSaleId,
      offset,
      limit: READBACK_PAGE_LIMIT,
    });

    const resp = data.response ?? {};
    totalCount = resp.total_count ?? totalCount;
    for (const info of resp.item_info ?? []) seenItems.add(String(info.item_id));
    models.push(...(resp.models ?? []));

    if (totalCount == null || seenItems.size >= totalCount || (resp.item_info ?? []).length === 0) break;
    offset += READBACK_PAGE_LIMIT;
  }

  return { models, totalCount: totalCount ?? seenItems.size };
}

/**
 * Full per-model diff of what we SENT against what Shopee actually PERSISTED.
 * This is the only source of truth about a copy's outcome.
 */
export function diffSentVsPersisted(payloadItems, persistedModels) {
  const sent = new Map();
  for (const item of payloadItems) {
    for (const m of item.models) {
      sent.set(`${item.item_id}:${m.model_id}`, {
        itemId: String(item.item_id),
        modelId: String(m.model_id),
        price: Number(m.input_promo_price),
        stock: Number(m.stock),
      });
    }
  }

  const persisted = new Map(
    persistedModels.map((m) => [`${m.item_id}:${m.model_id}`, m])
  );

  const missing = [];
  const priceMismatches = [];
  const stockMismatches = [];
  const rejected = [];
  const unexpected = [];

  for (const [key, s] of sent) {
    const p = persisted.get(key);
    if (!p) {
      missing.push({ key, itemId: s.itemId, modelId: s.modelId, price: s.price });
      continue;
    }
    // Money compared with a half-cent tolerance rather than ===, so a float
    // round-trip can't masquerade as Shopee silently repricing.
    if (Math.abs(Number(p.input_promotion_price) - s.price) >= 0.005) {
      priceMismatches.push({ key, sent: s.price, persisted: Number(p.input_promotion_price) });
    }
    if (Number(p.campaign_stock) !== s.stock) {
      stockMismatches.push({ key, sent: s.stock, persisted: Number(p.campaign_stock) });
    }
  }

  for (const [key, p] of persisted) {
    if (!sent.has(key)) unexpected.push({ key, modelName: p.model_name ?? null });
    // status 1 = enabled. Anything else on a model we just wrote, or any
    // reject_reason at all, is surfaced rather than averaged away.
    if (p.reject_reason || (p.status != null && p.status !== 1)) {
      rejected.push({
        key,
        status: p.status ?? null,
        modelName: p.model_name ?? null,
        reason: p.reject_reason || null,
      });
    }
  }

  const clean =
    missing.length === 0 &&
    priceMismatches.length === 0 &&
    stockMismatches.length === 0 &&
    rejected.length === 0;

  return {
    sentCount: sent.size,
    persistedCount: persisted.size,
    missing,
    priceMismatches,
    stockMismatches,
    rejected,
    unexpected,
    status: clean ? 'success' : 'partial',
  };
}

/**
 * Copies one session's enabled items into a NEW flash sale on the given slot.
 *
 * Sequence, and the reason it is ordered this way:
 *   1. create_shop_flash_sale  — yields an EMPTY session. Nothing is
 *      buyer-visible at this point, so a failure here costs nothing.
 *   2. add_shop_flash_sale_items — returns an empty body; tells us nothing.
 *   3. read-back + diff — the actual verdict.
 *
 * A step-2 or step-3 failure deliberately LEAVES the created session in place
 * rather than rolling it back. Deleting on failure would destroy the evidence
 * of what went wrong, and an empty or half-filled upcoming session is
 * harmless; the returned flashSaleId always names it so it can be inspected or
 * cleaned up deliberately.
 *
 * Returns { status: 'success' | 'partial', ... } — never throws to signal a
 * partial write, because a thrown error would lose the diff.
 */
export async function copyFlashSale(store, { sourceRowId, timeslotId }, options = {}) {
  if (!COPY_ENABLED) {
    throw new Error('Copy is disabled (COPY_ENABLED=false in api/_lib/flashSaleCopy.js)');
  }

  const deadline = options.deadline ?? Date.now() + 25_000;
  const freshStore = await ensureFreshToken(store);

  // ---- source ----
  const { data: source, error: sourceError } = await supabaseAdmin
    .from('flash_sales')
    .select('id, store_id, flash_sale_id, start_time, end_time')
    .eq('id', sourceRowId)
    .eq('store_id', store.id)
    .maybeSingle();
  if (sourceError) throw new Error(`failed to load source session: ${sourceError.message}`);
  if (!source) throw new Error('source session not found for this store');

  const { data: sourceItems, error: itemsError } = await selectAllPaged(
    `flashCopy.source[${sourceRowId}]`,
    (from, to) =>
      supabaseAdmin
        .from('flash_sale_items')
        .select('item_id, model_id, item_name, model_name, status, input_promotion_price, campaign_stock, purchase_limit')
        .eq('flash_sale_row_id', sourceRowId)
        .range(from, to)
  );
  if (itemsError) throw new Error(`failed to load source items: ${itemsError.message}`);

  const payloadItems = buildCopyPayload(sourceItems ?? []);
  if (payloadItems.length === 0) {
    throw new Error('source session has no enabled items to copy');
  }

  // ---- guard: slot must be free for THIS store ----
  const { data: occupied, error: occupiedError } = await supabaseAdmin
    .from('flash_sales')
    .select('id, flash_sale_id')
    .eq('store_id', store.id)
    .eq('timeslot_id', String(timeslotId))
    .limit(1);
  if (occupiedError) throw new Error(`failed to check slot: ${occupiedError.message}`);
  if ((occupied ?? []).length > 0) {
    throw new Error(`slot ${timeslotId} already has a session (${occupied[0].flash_sale_id}) for this store`);
  }

  // ---- 1. create ----
  const created = await flashSalePost(freshStore, '/api/v2/shop_flash_sale/create_shop_flash_sale', {
    timeslot_id: Number(timeslotId),
  });
  const flashSaleId = created.response?.flash_sale_id;
  if (!flashSaleId) {
    throw new Error('create_shop_flash_sale returned no flash_sale_id');
  }
  console.log(`[flash-copy] [${store.id}] created fs=${flashSaleId} on slot ${timeslotId}`);

  // ---- 2. add items (response is empty and proves nothing) ----
  let addError = null;
  try {
    await flashSalePost(freshStore, '/api/v2/shop_flash_sale/add_shop_flash_sale_items', {
      flash_sale_id: Number(flashSaleId),
      items: payloadItems,
    });
  } catch (err) {
    // Recorded, not rethrown: the add may still have applied partially, and
    // the read-back below is the only way to find out. Reporting the throw
    // alone would be exactly the silent-failure mode this whole path exists
    // to avoid.
    addError = err.message;
    console.error(`[flash-copy] [${store.id}] add rejected for fs=${flashSaleId}:`, err.message);
  }

  // ---- 3. MANDATORY read-back + diff ----
  let diff;
  try {
    const { models } = await readBackModels(freshStore, flashSaleId, { deadline });
    diff = diffSentVsPersisted(payloadItems, models);
  } catch (err) {
    // Without a read-back we simply do not know what landed. That is reported
    // as unverified — never as success.
    console.error(`[flash-copy] [${store.id}] read-back failed for fs=${flashSaleId}:`, err.message);
    return {
      status: 'unverified',
      flashSaleId: String(flashSaleId),
      timeslotId: String(timeslotId),
      sourceFlashSaleId: String(source.flash_sale_id),
      sentCount: payloadItems.reduce((n, i) => n + i.models.length, 0),
      addError,
      readBackError: err.message,
    };
  }

  const status = addError && diff.status === 'success' ? 'partial' : diff.status;

  return {
    status,
    flashSaleId: String(flashSaleId),
    timeslotId: String(timeslotId),
    sourceFlashSaleId: String(source.flash_sale_id),
    itemCount: payloadItems.length,
    addError,
    ...diff,
  };
}
