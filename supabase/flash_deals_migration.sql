-- ============================================================================
-- Flash Deals migration — run once in the Supabase SQL editor.
-- READ-ONLY monitoring of Shopee shop flash sales. No write path to Shopee;
-- BigSeller continues to own slot creation. Idempotent: safe to re-run.
--
-- Verified against Partner ID 2038912 on production, 2026-07-26:
--   /api/v2/shop_flash_sale/get_time_slot_id          (note: NOT
--        get_shop_flash_sale_time_slot_id — that path 404s)
--   /api/v2/shop_flash_sale/get_shop_flash_sale_list
--   /api/v2/shop_flash_sale/get_shop_flash_sale_items
-- ============================================================================

-- flash_sales: one row per Shopee flash sale session we're tracking.
-- Sync scope is deliberately narrow — upcoming + ongoing + expired-last-7-days.
-- The full history is ~3000 rows/store and is pure noise, so rows aging out of
-- that window are pruned rather than accumulated.
create table if not exists flash_sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  flash_sale_id text not null,
  timeslot_id text,
  -- Shopee's own enums, stored raw so the UI maps them rather than us
  -- lossily re-encoding: status 0=deleted 1=enabled 2=disabled 3=system_rejected
  status int,
  -- type 1=upcoming 2=ongoing 3=expired. Shopee recomputes this per request
  -- relative to now, so it is a poll result, never authoritative between polls
  -- — the UI derives live state from start_time/end_time instead.
  type int,
  start_time timestamptz,
  end_time timestamptz,
  -- item_count is trusted; enabled_item_count is NOT. Shopee reports
  -- enabled_item_count=0 on expired sales while get_shop_flash_sale_items
  -- still returns 212 enabled models for the same sale (verified 2026-07-26).
  -- The reported value is kept for reference; the *_derived/model counts below
  -- are computed from the items endpoint and are what the UI reads.
  item_count int,
  enabled_item_count_reported int,
  enabled_item_count_derived int,
  enabled_model_count int,
  -- live engagement counters: overwritten every poll, never accumulated
  click_count int default 0,
  remindme_count int default 0,
  observed_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (store_id, flash_sale_id)
);

-- Brings an already-created table up to date; no-op on a fresh install.
alter table flash_sales add column if not exists enabled_item_count_derived int;

create index if not exists idx_flash_sales_store_time
  on flash_sales (store_id, start_time desc);
create index if not exists idx_flash_sales_window
  on flash_sales (store_id, end_time);

-- flash_sale_items: MODEL-grained (one row per variant), because that is the
-- grain Shopee prices and allocates stock at. Items with no variants still
-- arrive as a single model row.
--
-- NOTE ON campaign_stock: this is the ALLOCATED promo quota, not a remaining
-- counter. Verified 2026-07-26 — a January sale with 6 clicks still reports its
-- original campaign_stock, and no enabled model was ever observed at 0. Shopee
-- exposes no units-sold or stock-left field. item_stock below is the product's
-- LIVE stock at poll time (not a campaign snapshot), so it must not be read as
-- "flash sale stock left". Deriving true stock-left is deferred out of v1.
create table if not exists flash_sale_items (
  id uuid primary key default gen_random_uuid(),
  flash_sale_row_id uuid references flash_sales(id) on delete cascade,
  store_id uuid references stores(id) on delete cascade,
  item_id text not null,
  model_id text not null,
  item_name text,
  model_name text,
  -- raw Shopee image id, not a URL; the UI prefers products.image_url and
  -- builds a CDN URL from this only as a fallback
  image text,
  -- 0=disabled 1=enabled 2=deleted 4=system_rejected 5=manual_rejected
  status int,
  original_price decimal(10, 2),
  input_promotion_price decimal(10, 2),
  promotion_price_with_tax decimal(10, 2),
  purchase_limit int,
  campaign_stock int,
  item_stock int,
  reject_reason text,
  -- best-effort link to our catalogue; item-level only, since products has no
  -- variant table to join model_id against
  product_id uuid references products(id) on delete set null,
  observed_at timestamptz default now(),
  unique (flash_sale_row_id, item_id, model_id)
);

create index if not exists idx_flash_sale_items_sale
  on flash_sale_items (flash_sale_row_id);
create index if not exists idx_flash_sale_items_store
  on flash_sale_items (store_id, item_id);

-- flash_sale_slots: cached get_time_slot_id output. Shop-independent (the same
-- fixed windows are returned for every shop), so rows are keyed on timeslot_id
-- alone. Horizon is ~18 days — Shopee truncates there even when asked for 90.
-- Fixed daily windows (MYT): 00-09, 09-12, 12-14, 14-16, 16-20, 20-00.
create table if not exists flash_sale_slots (
  timeslot_id text primary key,
  start_time timestamptz not null,
  end_time timestamptz not null,
  observed_at timestamptz default now()
);

create index if not exists idx_flash_sale_slots_start
  on flash_sale_slots (start_time);

-- ---- RLS: flash_sales (own store only; cron writes via service-role key) ----
alter table flash_sales enable row level security;

drop policy if exists "flash_sales_select_own" on flash_sales;
create policy "flash_sales_select_own" on flash_sales
  for select using (
    exists (select 1 from stores where stores.id = flash_sales.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sales_insert_own" on flash_sales;
create policy "flash_sales_insert_own" on flash_sales
  for insert with check (
    exists (select 1 from stores where stores.id = flash_sales.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sales_update_own" on flash_sales;
create policy "flash_sales_update_own" on flash_sales
  for update using (
    exists (select 1 from stores where stores.id = flash_sales.store_id and stores.user_id = auth.uid())
  ) with check (
    exists (select 1 from stores where stores.id = flash_sales.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sales_delete_own" on flash_sales;
create policy "flash_sales_delete_own" on flash_sales
  for delete using (
    exists (select 1 from stores where stores.id = flash_sales.store_id and stores.user_id = auth.uid())
  );

-- ---- RLS: flash_sale_items (own store only) ----
alter table flash_sale_items enable row level security;

drop policy if exists "flash_sale_items_select_own" on flash_sale_items;
create policy "flash_sale_items_select_own" on flash_sale_items
  for select using (
    exists (select 1 from stores where stores.id = flash_sale_items.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sale_items_insert_own" on flash_sale_items;
create policy "flash_sale_items_insert_own" on flash_sale_items
  for insert with check (
    exists (select 1 from stores where stores.id = flash_sale_items.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sale_items_update_own" on flash_sale_items;
create policy "flash_sale_items_update_own" on flash_sale_items
  for update using (
    exists (select 1 from stores where stores.id = flash_sale_items.store_id and stores.user_id = auth.uid())
  ) with check (
    exists (select 1 from stores where stores.id = flash_sale_items.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "flash_sale_items_delete_own" on flash_sale_items;
create policy "flash_sale_items_delete_own" on flash_sale_items
  for delete using (
    exists (select 1 from stores where stores.id = flash_sale_items.store_id and stores.user_id = auth.uid())
  );

-- ---- RLS: flash_sale_slots (shop-independent reference data; any signed-in
-- user may read, only the service-role cron writes) ----
alter table flash_sale_slots enable row level security;

drop policy if exists "flash_sale_slots_select_all" on flash_sale_slots;
create policy "flash_sale_slots_select_all" on flash_sale_slots
  for select using (auth.uid() is not null);
