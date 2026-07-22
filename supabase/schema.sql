-- MyStore Hub database schema
-- Paste directly into the Supabase SQL Editor

create extension if not exists "pgcrypto";

-- 1. stores
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  platform text not null,
  shop_id text not null,
  shop_name text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  is_active boolean default true,
  last_synced_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, platform, shop_id)
);

-- 2. orders
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  platform text,
  platform_order_id text not null,
  order_status text,
  buyer_name text,
  buyer_phone text,
  shipping_address text,
  region text,
  total_amount decimal(10, 2),
  currency text default 'MYR',
  payment_method text,
  courier_name text,
  tracking_number text,
  awb_url text,
  awb_printed boolean default false,
  awb_printed_at timestamptz,
  paid_at timestamptz,
  packed_at timestamptz,
  shipped_at timestamptz,
  order_created_at timestamptz,
  synced_at timestamptz default now(),
  unique (store_id, platform_order_id)
);

-- Added after the initial schema; `create table if not exists` above is a no-op
-- on databases that already exist, so bring them up to date too.
alter table orders add column if not exists awb_printed boolean default false;
alter table orders add column if not exists awb_printed_at timestamptz;

-- Scan-to-check: Shopee's package_number (from get_order_detail's package_list,
-- free — no extra API call) alongside tracking_number (only obtainable via a
-- separate get_tracking_number call). Some AWB barcodes encode one, some the
-- other, so both are stored and the scan looks up either.
alter table orders add column if not exists package_number text;
create index if not exists idx_orders_tracking_number on orders (tracking_number);
create index if not exists idx_orders_package_number on orders (package_number);

-- 3. order_items
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  product_name text,
  variant_name text,
  sku text,
  quantity integer,
  price decimal(10, 2),
  image_url text
);

-- 4. products
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  platform text,
  platform_product_id text not null,
  title text,
  sku text,
  price decimal(10, 2),
  stock integer,
  image_url text,
  status text,
  synced_at timestamptz default now(),
  unique (store_id, platform_product_id)
);

-- 5. sync_logs
create table if not exists sync_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  sync_type text,
  status text,
  message text,
  synced_at timestamptz default now()
);

-- Indexes
create index if not exists idx_orders_store_id_order_status on orders (store_id, order_status);
create index if not exists idx_orders_platform_order_id on orders (platform_order_id);
create index if not exists idx_products_store_id_sku on products (store_id, sku);

-- Atomically replaces every order_items row for a batch of orders in a single
-- transaction. Two callers (e.g. a cron sync and a foreground auto-sync)
-- writing the same order concurrently used to be able to race a "delete
-- everything except what I just inserted" step and delete each other's fresh
-- rows, leaving the order with zero items. Deleting then inserting inside one
-- transaction removes that window entirely: concurrent calls serialize on
-- Postgres's row lock for the delete, and whichever commits last simply
-- leaves its own full, fresh item set — never an empty one.
create or replace function replace_order_items(p_order_ids uuid[], p_items jsonb)
returns void
language plpgsql
as $$
begin
  delete from order_items where order_id = any(p_order_ids);

  insert into order_items (order_id, product_name, variant_name, sku, quantity, price, image_url)
  select
    (item->>'order_id')::uuid,
    item->>'product_name',
    item->>'variant_name',
    item->>'sku',
    (item->>'quantity')::integer,
    (item->>'price')::decimal,
    item->>'image_url'
  from jsonb_array_elements(p_items) as item;
end;
$$;

-- Auto-pack: per-store opt-in flag. Default false — must be turned on
-- explicitly per store, never inherited or globally on.
alter table stores add column if not exists auto_pack_enabled boolean not null default false;

-- Auto-pack: per-order outcome tracking.
-- auto_pack_status is the retry gate: eligibility is `order_status =
-- 'READY_TO_SHIP' and auto_pack_status is null`. Once set to ANY terminal
-- value ('success' | 'failed' | 'skipped'), that order is never reconsidered
-- by auto-pack again, so a failure does not retry every cron tick forever.
-- packed_by distinguishes the manual Pack button from auto-pack in the UI.
alter table orders add column if not exists auto_pack_status text;
alter table orders add column if not exists auto_pack_error text;
alter table orders add column if not exists auto_pack_attempted_at timestamptz;
alter table orders add column if not exists packed_by text;

create index if not exists idx_orders_store_id_auto_pack_status on orders (store_id, auto_pack_status);

-- Tracking backfill: per-order cooldown so a get_tracking_number call that
-- succeeds but comes back empty (eligible status, Shopee just has no AWB on
-- file yet) isn't retried every single cron cycle forever — see
-- backfillTrackingNumbers() in api/_lib/shopeeSync.js. Unlike auto_pack_status
-- above this is a timestamp cooldown, not a terminal flag: the order may
-- legitimately get a tracking number later, so it's retried again after
-- TRACKING_BACKFILL_RETRY_COOLDOWN_MS instead of being gated off for good.
alter table orders add column if not exists tracking_backfill_attempted_at timestamptz;

create index if not exists idx_orders_store_id_tracking_backfill on orders (store_id, tracking_number, tracking_backfill_attempted_at);
