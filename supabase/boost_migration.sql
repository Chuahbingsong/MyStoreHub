-- ============================================================================
-- Boost migration — run once in the Supabase SQL editor.
-- This is the subset of schema.sql + rls.sql that adds auto-boost. It was never
-- applied to the live DB, which is why the Boost page showed
-- "No Shopee stores connected yet" (the stores query selects auto_boost_enabled,
-- a column that didn't exist, so the whole select errored and returned empty).
-- Idempotent: safe to re-run.
-- ============================================================================

-- Auto-boost: per-store opt-in. When true, MyStore Hub OWNS this store's 5
-- Shopee boost slots and re-boosts a product rotation into them every ~4h.
alter table stores add column if not exists auto_boost_enabled boolean not null default false;

-- boost_rotation: the ordered pool of products a store cycles its 5 boost slots
-- through (least-recently-boosted first).
create table if not exists boost_rotation (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  position int not null default 0,
  last_boosted_at timestamptz,
  created_at timestamptz default now(),
  unique (store_id, product_id)
);
create index if not exists idx_boost_rotation_store on boost_rotation (store_id, last_boosted_at);

-- boost_slots: per-cron-cycle snapshot of Shopee's get_boosted_list for a store.
create table if not exists boost_slots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  item_id text not null,
  product_id uuid references products(id) on delete set null,
  cool_down_second int,
  reboostable_at timestamptz,
  externally_controlled boolean not null default false,
  observed_at timestamptz default now(),
  unique (store_id, item_id)
);
create index if not exists idx_boost_slots_store on boost_slots (store_id);

-- ---- RLS: boost_rotation (own store only) ----
alter table boost_rotation enable row level security;

drop policy if exists "boost_rotation_select_own" on boost_rotation;
create policy "boost_rotation_select_own" on boost_rotation
  for select using (
    exists (select 1 from stores where stores.id = boost_rotation.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_rotation_insert_own" on boost_rotation;
create policy "boost_rotation_insert_own" on boost_rotation
  for insert with check (
    exists (select 1 from stores where stores.id = boost_rotation.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_rotation_update_own" on boost_rotation;
create policy "boost_rotation_update_own" on boost_rotation
  for update using (
    exists (select 1 from stores where stores.id = boost_rotation.store_id and stores.user_id = auth.uid())
  ) with check (
    exists (select 1 from stores where stores.id = boost_rotation.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_rotation_delete_own" on boost_rotation;
create policy "boost_rotation_delete_own" on boost_rotation
  for delete using (
    exists (select 1 from stores where stores.id = boost_rotation.store_id and stores.user_id = auth.uid())
  );

-- ---- RLS: boost_slots (own store only; cron writes via service-role key) ----
alter table boost_slots enable row level security;

drop policy if exists "boost_slots_select_own" on boost_slots;
create policy "boost_slots_select_own" on boost_slots
  for select using (
    exists (select 1 from stores where stores.id = boost_slots.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_slots_insert_own" on boost_slots;
create policy "boost_slots_insert_own" on boost_slots
  for insert with check (
    exists (select 1 from stores where stores.id = boost_slots.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_slots_update_own" on boost_slots;
create policy "boost_slots_update_own" on boost_slots
  for update using (
    exists (select 1 from stores where stores.id = boost_slots.store_id and stores.user_id = auth.uid())
  ) with check (
    exists (select 1 from stores where stores.id = boost_slots.store_id and stores.user_id = auth.uid())
  );

drop policy if exists "boost_slots_delete_own" on boost_slots;
create policy "boost_slots_delete_own" on boost_slots
  for delete using (
    exists (select 1 from stores where stores.id = boost_slots.store_id and stores.user_id = auth.uid())
  );
