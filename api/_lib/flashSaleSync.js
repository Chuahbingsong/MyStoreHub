import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from './shopee.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { acquireSyncLock, logSyncStart, logSyncComplete, ensureFreshToken } from './shopeeSync.js';
import { selectAllPaged, warnIfAtCap } from './supabaseSelect.js';

// Flash Deals sync — READ-ONLY monitoring of Shopee shop flash sales.
//
// There is deliberately NO write path here. BigSeller is actively filling every
// slot on these shops (2977 sessions on Cats Play Toy, 2844 on Big Hammer, 1606
// on Meow Fun as of 2026-07-26), so MyStore Hub coexists as an observer only.
// Nothing in this file calls create/add/update/delete on Shopee.
//
// ENDPOINTS (verified live against Partner ID 2038912 on production, 2026-07-26):
//   GET /api/v2/shop_flash_sale/get_time_slot_id
//       NOTE the short name. Shopee's own doc URL says
//       get_shop_flash_sale_time_slot_id — that path returns HTTP 404
//       error_not_found. Same class of doc-vs-reality gap as the boost
//       cool_down_second case; the name below is the one that actually works.
//   GET /api/v2/shop_flash_sale/get_shop_flash_sale_list
//   GET /api/v2/shop_flash_sale/get_shop_flash_sale_items
//
// STOCK SEMANTICS — the thing most likely to be misread later:
//   campaign_stock is the ALLOCATED promo quota, NOT a remaining counter. A
//   January session with 6 clicks still reported its original campaign_stock,
//   and no enabled model was ever observed sitting at 0 (the zeros all belong
//   to status=0 disabled models). `stock` is the product's LIVE stock at request
//   time, not a campaign snapshot — identical values came back for a 6-month-old
//   session and today's ongoing one. Shopee exposes no units-sold field, so
//   "stock left" is NOT derivable from this API and is deliberately out of v1.

const EXPIRED_WINDOW_DAYS = 7;
const LIST_PAGE_LIMIT = 100; // Shopee max; offset caps at 1000 (verified: 1100 -> param_error)
const ITEM_PAGE_LIMIT = 50; // Shopee max; paginates ITEMS, not models
// Slots are shop-independent fixed windows, so they're refreshed on a slow
// timer rather than once per store per tick.
const SLOT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const TYPE_UPCOMING = 1;
const TYPE_ONGOING = 2;
const TYPE_EXPIRED = 3;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/**
 * Signed GET against a shop_flash_sale endpoint. Common params ride the query
 * string (v2 convention). Throws on a non-empty top-level `error`, which means
 * the WHOLE call was rejected — an out-of-scope module, a dead token, or a bad
 * param name. Never returns a partially-usable body.
 */
async function flashSaleGet(store, path, extra = {}) {
  const timestamp = nowUnix();
  const sign = generateSign(path, timestamp, store.access_token, store.shop_id);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: store.access_token,
    shop_id: String(store.shop_id),
    sign,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });

  const response = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[flash-sale] call rejected', path, data);
    throw new Error(data.message || data.error || `${path} rejected`);
  }

  return data;
}

/* ------------------------------ time slots -------------------------------- */

/**
 * Caches get_time_slot_id into flash_sale_slots. Shop-independent — the same
 * fixed windows come back for every shop — so this runs on a 12h timer keyed on
 * the freshest row, not once per store per cron tick.
 *
 * The horizon is ~18 days: asking for 90 days returned 109 slots ending at
 * +18.3d, so Shopee truncates rather than erroring. We ask for 30 and take
 * whatever it gives rather than hardcoding the cutoff.
 */
export async function syncFlashSaleSlots(store, options = {}) {
  const { force = false } = options;

  if (!force) {
    const { data: freshest } = await supabaseAdmin
      .from('flash_sale_slots')
      .select('observed_at')
      .order('observed_at', { ascending: false })
      .limit(1);

    const lastObserved = freshest?.[0]?.observed_at ? new Date(freshest[0].observed_at).getTime() : 0;
    if (Date.now() - lastObserved < SLOT_REFRESH_INTERVAL_MS) {
      return { slots: 0, skipped: 'fresh' };
    }
  }

  const start = nowUnix();
  const data = await flashSaleGet(store, '/api/v2/shop_flash_sale/get_time_slot_id', {
    start_time: start,
    end_time: start + 30 * 24 * 60 * 60,
  });

  // `response` is a BARE ARRAY here, not an object with a list field — unlike
  // every other endpoint in this module.
  const slots = Array.isArray(data.response) ? data.response : [];
  if (slots.length === 0) return { slots: 0 };

  const observedAt = new Date().toISOString();
  const rows = slots.map((s) => ({
    timeslot_id: String(s.timeslot_id),
    start_time: toIso(s.start_time),
    end_time: toIso(s.end_time),
    observed_at: observedAt,
  }));

  const { error } = await supabaseAdmin
    .from('flash_sale_slots')
    .upsert(rows, { onConflict: 'timeslot_id' });
  if (error) throw new Error(`failed to upsert flash_sale_slots: ${error.message}`);

  // Drop slots that have fallen out of the horizon so the table stays a window,
  // not an archive.
  await supabaseAdmin
    .from('flash_sale_slots')
    .delete()
    .lt('end_time', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  return { slots: rows.length };
}

/* ----------------------------- sessions + items ---------------------------- */

/**
 * One page-loop over get_shop_flash_sale_list for a given type. Shopee returns
 * sessions newest-first (verified), and `offset` hard-caps at 1000, so the loop
 * stops at that ceiling rather than paging into a param_error.
 */
async function fetchFlashSaleList(store, type, { deadline, stopBefore = null }) {
  const sales = [];
  let offset = 0;

  while (Date.now() < deadline && offset <= 1000 - LIST_PAGE_LIMIT) {
    const data = await flashSaleGet(store, '/api/v2/shop_flash_sale/get_shop_flash_sale_list', {
      type,
      offset,
      limit: LIST_PAGE_LIMIT,
    });

    const page = data.response?.flash_sale_list ?? [];
    if (page.length === 0) break;

    // Newest-first ordering lets an expired-window scan bail as soon as it
    // walks past the cutoff instead of paging the full ~3000-row history.
    let hitCutoff = false;
    for (const sale of page) {
      if (stopBefore != null && sale.start_time < stopBefore) {
        hitCutoff = true;
        break;
      }
      sales.push(sale);
    }
    if (hitCutoff) break;

    if (page.length < LIST_PAGE_LIMIT) break;
    offset += LIST_PAGE_LIMIT;
  }

  return sales;
}

/**
 * Pages get_shop_flash_sale_items for one session. Returns the flattened model
 * rows joined to their item_info (name + image live on item_info, price and
 * stock on models).
 */
async function fetchFlashSaleItems(store, flashSaleId, { deadline }) {
  const models = [];
  const itemInfoById = new Map();
  let offset = 0;
  let totalCount = null;

  while (Date.now() < deadline) {
    const data = await flashSaleGet(store, '/api/v2/shop_flash_sale/get_shop_flash_sale_items', {
      flash_sale_id: flashSaleId,
      offset,
      limit: ITEM_PAGE_LIMIT,
    });

    const resp = data.response ?? {};
    totalCount = resp.total_count ?? totalCount;

    for (const info of resp.item_info ?? []) {
      itemInfoById.set(String(info.item_id), info);
    }
    models.push(...(resp.models ?? []));

    const seenItems = itemInfoById.size;
    if (totalCount == null || seenItems >= totalCount || (resp.item_info ?? []).length === 0) break;
    offset += ITEM_PAGE_LIMIT;
  }

  return { models, itemInfoById, totalCount: totalCount ?? itemInfoById.size };
}

/**
 * Upserts one session's models into flash_sale_items and prunes rows for models
 * Shopee no longer returns. Returns the enabled counts derived from the ITEMS
 * endpoint — which is the trustworthy source: the list endpoint reports
 * enabled_item_count=0 on expired sessions while the items endpoint still
 * returns 212 enabled models for the very same session (verified 2026-07-26).
 */
async function persistItems(storeId, flashSaleRowId, models, itemInfoById, productIdByItemId) {
  const observedAt = new Date().toISOString();

  const rows = models.map((m) => {
    const itemId = String(m.item_id);
    const info = itemInfoById.get(itemId);
    return {
      flash_sale_row_id: flashSaleRowId,
      store_id: storeId,
      item_id: itemId,
      model_id: String(m.model_id),
      item_name: info?.item_name ?? null,
      model_name: m.model_name ?? null,
      // Raw Shopee image id (e.g. "sg-11134201-7rd4m-..."), not a URL — the UI
      // prefers the synced product's image_url and builds a CDN URL from this
      // only as a fallback.
      image: info?.image ?? null,
      status: m.status ?? null,
      original_price: m.original_price ?? null,
      input_promotion_price: m.input_promotion_price ?? null,
      promotion_price_with_tax: m.promotion_price_with_tax ?? null,
      purchase_limit: m.purchase_limit ?? null,
      campaign_stock: m.campaign_stock ?? null,
      item_stock: m.stock ?? null,
      reject_reason: m.reject_reason || null,
      product_id: productIdByItemId.get(itemId) ?? null,
      observed_at: observedAt,
    };
  });

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from('flash_sale_items')
      .upsert(rows, { onConflict: 'flash_sale_row_id,item_id,model_id' });
    if (error) throw new Error(`failed to upsert flash_sale_items: ${error.message}`);
  }

  // Prune models this session no longer carries. Scoped to the one session, so
  // a partial fetch elsewhere can never delete another session's rows.
  const keep = rows.map((r) => `${r.item_id}:${r.model_id}`);
  // Scoped to ONE session (max ~239 models observed), so the cap is far off.
  // Truncation here would under-delete, never over-delete, but warn anyway so
  // it can't become another invisible cap.
  const { data: existing } = await supabaseAdmin
    .from('flash_sale_items')
    .select('id, item_id, model_id')
    .eq('flash_sale_row_id', flashSaleRowId);
  warnIfAtCap(`flash_sale_items.prune[${flashSaleRowId}]`, existing);

  const stale = (existing ?? []).filter((e) => !keep.includes(`${e.item_id}:${e.model_id}`));
  if (stale.length > 0) {
    await supabaseAdmin
      .from('flash_sale_items')
      .delete()
      .in('id', stale.map((s) => s.id));
  }

  const enabled = rows.filter((r) => r.status === 1);
  return {
    enabledModelCount: enabled.length,
    enabledItemCount: new Set(enabled.map((r) => r.item_id)).size,
  };
}

/**
 * Syncs one store's flash sales, read-only. Mirrors autoBoostStore's contract:
 * acquireSyncLock keyed on store.id, sync_logs started/completed bookkeeping
 * (including the timeout-visible 'started'-with-no-completion signature), and a
 * shared caller deadline it must not exceed.
 *
 * SCOPE, deliberately narrow: upcoming + ongoing + expired-within-7-days. The
 * full history is ~3000 sessions per store — pure noise and far beyond the cron
 * budget — so it is never walked.
 *
 * options.deadline: shares the caller's per-store time budget — no fresh window.
 */
export async function syncStoreFlashSales(store, options = {}) {
  const deadline = options.deadline ?? Date.now() + 45_000;

  const canProceed = await acquireSyncLock(store.id, 'flash_sales');
  if (!canProceed) {
    console.log(`[flash-sale] [${store.id}] already in progress elsewhere, skipping`);
    return { storeId: store.id, sessions: 0, locked: true };
  }

  const logId = await logSyncStart(store.id, 'flash_sales');

  try {
    const freshStore = await ensureFreshToken(store);

    // Slot cache first — cheap, shop-independent, self-throttling to 12h.
    try {
      await syncFlashSaleSlots(freshStore);
    } catch (err) {
      // A slot-cache failure must not sink the session sync; slots are only
      // reference data for the UI's calendar.
      console.error(`[flash-sale] [${store.id}] slot cache refresh failed:`, err.message);
    }

    // Paged: truncation would silently null out product_id linkage on flash
    // sale items for everything past the cap.
    const { data: products, error: productsError } = await selectAllPaged(
      `products.flashMap[${store.id}]`,
      (from, to) =>
        supabaseAdmin.from('products').select('id, platform_product_id').eq('store_id', store.id).range(from, to)
    );
    if (productsError) throw new Error(`failed to load products: ${productsError.message}`);

    const productIdByItemId = new Map(
      (products ?? []).map((p) => [String(p.platform_product_id), p.id])
    );

    const expiredCutoff = nowUnix() - EXPIRED_WINDOW_DAYS * 24 * 60 * 60;

    // Three list calls, one per type. Kept separate rather than filtering a
    // type=0 sweep, because only the expired scan needs the cutoff walk.
    const [upcoming, ongoing, expired] = [
      await fetchFlashSaleList(freshStore, TYPE_UPCOMING, { deadline }),
      await fetchFlashSaleList(freshStore, TYPE_ONGOING, { deadline }),
      await fetchFlashSaleList(freshStore, TYPE_EXPIRED, { deadline, stopBefore: expiredCutoff }),
    ];

    // Dedupe by flash_sale_id before upserting. The three list calls are
    // sequential, so a session that crosses its start boundary between the
    // type=1 and type=2 calls comes back in BOTH — and a single upsert batch
    // containing the same conflict key twice is a hard Postgres error
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), which
    // would sink the whole store's sync. Later types win, so the freshest view
    // (ongoing over upcoming) is the one kept.
    const sessionById = new Map();
    for (const s of [...upcoming, ...ongoing, ...expired]) {
      sessionById.set(String(s.flash_sale_id), s);
    }
    const sessions = [...sessionById.values()];

    if (sessions.length === 0) {
      const msg = 'no flash sales in the upcoming/ongoing/last-7-days window';
      console.log(`[flash-sale] [${store.id}] ${msg}`);
      await logSyncComplete(logId, 'success', msg);
      return { storeId: store.id, sessions: 0, items: 0 };
    }

    const observedAt = new Date().toISOString();
    const sessionRows = sessions.map((s) => ({
      store_id: store.id,
      flash_sale_id: String(s.flash_sale_id),
      timeslot_id: s.timeslot_id != null ? String(s.timeslot_id) : null,
      status: s.status ?? null,
      type: s.type ?? null,
      start_time: toIso(s.start_time),
      end_time: toIso(s.end_time),
      item_count: s.item_count ?? null,
      // Stored but NOT trusted — see persistItems. The derived counts below
      // are what the UI reads.
      enabled_item_count_reported: s.enabled_item_count ?? null,
      click_count: s.click_count ?? 0,
      remindme_count: s.remindme_count ?? 0,
      observed_at: observedAt,
    }));

    const { data: upserted, error: upsertError } = await supabaseAdmin
      .from('flash_sales')
      .upsert(sessionRows, { onConflict: 'store_id,flash_sale_id' })
      // enabled_model_count comes back from the upsert because the payload
      // doesn't include it, so ON CONFLICT leaves the stored value alone.
      .select('id, flash_sale_id, enabled_model_count');
    if (upsertError) throw new Error(`failed to upsert flash_sales: ${upsertError.message}`);

    const rowIdByFlashSaleId = new Map((upserted ?? []).map((r) => [String(r.flash_sale_id), r.id]));

    // Which sessions already have items stored — an expired session is
    // immutable, so its items are fetched once and never re-fetched.
    //
    // The marker is enabled_model_count, which is written ONLY after
    // persistItems succeeds. It must NOT be derived by selecting from
    // flash_sale_items: PostgREST caps an unbounded select at 1000 rows, and
    // these stores hold 10k+ item rows each, so the tail of sessions would be
    // invisible and re-fetched on every single tick — unbounded repeated work
    // that quietly consumes the whole cron budget (observed live: Cats Play Toy
    // re-syncing 15 immutable expired sessions per run).
    const rowsWithItems = new Set(
      (upserted ?? []).filter((r) => r.enabled_model_count != null).map((r) => r.id)
    );

    let itemsSynced = 0;
    let sessionsWithItems = 0;
    let deferred = 0;
    const failures = [];

    for (const session of sessions) {
      const flashSaleId = String(session.flash_sale_id);
      const rowId = rowIdByFlashSaleId.get(flashSaleId);
      if (!rowId) continue;

      const isLive = session.type === TYPE_UPCOMING || session.type === TYPE_ONGOING;
      const alreadyHaveItems = rowsWithItems.has(rowId);
      // Live sessions re-sync every tick (prices/status/quota can still change).
      // Expired ones are frozen — fetch once, then never again. A session
      // genuinely holding zero items is skipped rather than re-probed forever.
      if (!isLive && (alreadyHaveItems || (session.item_count ?? 0) === 0)) continue;

      // Whatever doesn't fit this tick is reported, not silently dropped — the
      // next cron tick picks it up because its items are still missing.
      if (Date.now() >= deadline) {
        deferred += 1;
        continue;
      }

      try {
        const { models, itemInfoById } = await fetchFlashSaleItems(freshStore, flashSaleId, { deadline });
        const counts = await persistItems(store.id, rowId, models, itemInfoById, productIdByItemId);

        await supabaseAdmin
          .from('flash_sales')
          .update({
            enabled_model_count: counts.enabledModelCount,
            enabled_item_count_derived: counts.enabledItemCount,
          })
          .eq('id', rowId);

        itemsSynced += models.length;
        sessionsWithItems += 1;
      } catch (err) {
        // One session's item fetch failing must not abort the others, and must
        // not be counted as a success — it's enumerated in the completion
        // message so a persistently broken session stays visible.
        console.error(`[flash-sale] [${store.id}] items failed for fs=${flashSaleId}:`, err.message);
        failures.push(flashSaleId);
      }
    }

    // Prune sessions that have aged out of the 7-day expired window, so the
    // table stays a rolling window instead of accreting the full history.
    const pruneBefore = new Date(Date.now() - EXPIRED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: pruneError } = await supabaseAdmin
      .from('flash_sales')
      .delete()
      .eq('store_id', store.id)
      .lt('end_time', pruneBefore);
    if (pruneError) console.error('[flash-sale] failed to prune aged sessions', store.id, pruneError);

    const msg =
      `${sessions.length} session(s) (${upcoming.length} upcoming, ${ongoing.length} ongoing, ` +
      `${expired.length} expired-7d); items synced for ${sessionsWithItems} session(s), ${itemsSynced} model row(s)` +
      (deferred > 0 ? `; ${deferred} deferred to next tick (time budget)` : '') +
      (failures.length > 0 ? `; ITEM FETCH FAILED for fs: ${failures.join(', ')}` : '');

    // Sessions upserted fine but every attempted item fetch failed => error,
    // not a quiet success.
    const status = failures.length > 0 && sessionsWithItems === 0 ? 'error' : 'success';
    await logSyncComplete(logId, status, msg);
    console.log(`[flash-sale] [${store.id}] done: ${msg}`);

    return {
      storeId: store.id,
      sessions: sessions.length,
      upcoming: upcoming.length,
      ongoing: ongoing.length,
      expired: expired.length,
      items: itemsSynced,
      deferred,
      failures: failures.length,
    };
  } catch (err) {
    console.error(`[flash-sale] [${store.id}] failed:`, err.message);
    await logSyncComplete(logId, 'error', err.message);
    throw err;
  }
}
