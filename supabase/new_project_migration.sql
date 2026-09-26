-- ============================================================================
-- MyStore Hub — bring the NEW Supabase project (ebzfmepsyfflxnsvbexl) in line
-- with the old one (juhffkxckprlxrarrngv) and the repo. Paste into the SQL
-- editor of the NEW project ONLY and run once. Idempotent: safe to re-run.
--
-- Runs as ONE transaction: if any statement fails, nothing is applied.
--
--   PART A  Missing structure   — table, columns, indexes, functions
--           (A1 also stamps existing orders as notified — no notification blast)
--   PART C  Security            — RLS on every table, policies, revoke anon
--
-- Why this exists: the new project was created from schema.sql alone. rls.sql
-- and the RLS sections of the flash-deals / boost / logistics migrations never
-- ran, so the anon key (public — it ships in the frontend bundle) could read
-- every table. See PART C.
--
-- Function bodies and the logistics table are copied verbatim from
-- supabase/schema.sql, sales_reporting_migration.sql,
-- actionable_orders_migration.sql and logistics_channels_migration.sql.
-- ============================================================================

begin;

create extension if not exists "pgcrypto";

-- ============================================================================
-- PART A — MISSING STRUCTURE
-- ============================================================================

-- A1. orders.notified_new_at / notified_cancel_at, with existing orders stamped.
--     The push notifier (api/_lib/pushNotify.js) selects these; their absence is
--     why push has failed every 10 min since the cutover. They were not defined
--     in any checked-in migration until now.
--
--     Existing orders are stamped with now() in the SAME transaction as the
--     column add, so the first cron run after this cannot announce history as
--     "new". The stamp only runs when the column is being added: re-running this
--     file later does NOT re-stamp, so it can never silence a genuinely new order.
--     Consequence to expect: orders that arrived during the outage will not get
--     a push (they are still in the New Orders tab).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'notified_new_at'
  ) then
    alter table public.orders add column notified_new_at timestamptz;
    update public.orders set notified_new_at = now();
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'notified_cancel_at'
  ) then
    alter table public.orders add column notified_cancel_at timestamptz;
    update public.orders set notified_cancel_at = now();
  end if;
end $$;

-- A2. Columns present on the old project, absent on the new one.
alter table public.lazada_shops add column if not exists account text;
alter table public.tiktok_shops add column if not exists updated_at timestamptz not null default now();

-- A3. push_subscriptions — no DDL existed in the repo. Shape taken from the old
--     project. The unique index on endpoint is required by the client's
--     upsert(..., { onConflict: 'endpoint' }) in src/lib/push.js.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  locale text not null default 'en'
);
create unique index if not exists push_subscriptions_endpoint_key on public.push_subscriptions (endpoint);
create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);

-- A4. logistics_channel_audit — logistics_channels_migration.sql never ran on
--     the new project (table missing; the Shipping page's audit writes fail).
--     Verbatim from that file, lines 21-69. Its RLS is in PART C.
create table if not exists logistics_channel_audit (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,

  -- The channel the seller actually clicked.
  logistics_channel_id bigint not null,
  logistics_channel_name text,

  -- What the seller asked for, and what Shopee's state was immediately
  -- before the write (snapshotted from the same get_channel_list call that
  -- validated the request, so it is never a stale UI value).
  requested_enabled boolean not null,
  before_enabled boolean,

  -- What a full get_channel_list RE-FETCH showed afterwards. `confirmed` is
  -- (after_enabled = requested_enabled) as observed, not as reported by
  -- update_channel's own response — Shopee has been seen to 200 a write that
  -- did not take (e.g. toggling a child whose mask parent is disabled).
  after_enabled boolean,
  confirmed boolean not null default false,

  -- Other channels whose `enabled` changed in the same write. Shape:
  -- [{"logistics_channel_id":20007,"logistics_channel_name":"Poslaju",
  --   "before":true,"after":false}]
  -- Empty array is the normal, expected case.
  collateral jsonb not null default '[]'::jsonb,

  -- Populated when the write itself failed (Shopee error code/message) or
  -- when the read-back could not be performed.
  shopee_error text,

  -- Which logged-in user pressed the button.
  actor_user_id uuid,

  created_at timestamptz default now()
);

-- The page shows recent history per store, newest first.
create index if not exists idx_logistics_channel_audit_store_created
  on logistics_channel_audit (store_id, created_at desc);

-- "Has this channel ever been touched, and what happened last time?"
create index if not exists idx_logistics_channel_audit_channel
  on logistics_channel_audit (store_id, logistics_channel_id, created_at desc);

-- Surfacing unconfirmed writes (the ones worth investigating) cheaply.
create index if not exists idx_logistics_channel_audit_unconfirmed
  on logistics_channel_audit (store_id, created_at desc)
  where confirmed = false;
-- A5. Constraint from schema.sql (guarded; no-op if present).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_preferred_shipping_method_check'
  ) then
    alter table public.stores add constraint stores_preferred_shipping_method_check
      check (preferred_shipping_method in ('pickup', 'dropoff'));
  end if;
end $$;

-- A6. Every index the repo defines. Indexes can't be inspected on the new project
--     from outside (not exposed over the API), so all are re-asserted;
--     "if not exists" makes existing ones a no-op.
create index if not exists idx_orders_store_id_order_status on public.orders (store_id, order_status);
create index if not exists idx_orders_platform_order_id on public.orders (platform_order_id);
create index if not exists idx_products_store_id_sku on public.products (store_id, sku);
create index if not exists idx_orders_tracking_number on public.orders (tracking_number);
create index if not exists idx_orders_package_number on public.orders (package_number);
create index if not exists idx_orders_store_id_auto_pack_status on public.orders (store_id, auto_pack_status);
create index if not exists idx_orders_store_id_tracking_backfill on public.orders (store_id, tracking_number, tracking_backfill_attempted_at);
create index if not exists idx_orders_store_id_buyer_message on public.orders (store_id) where buyer_message is not null;
create index if not exists idx_orders_created_at on public.orders (order_created_at);
create index if not exists idx_orders_paid_at on public.orders (paid_at);
create index if not exists idx_boost_rotation_store on public.boost_rotation (store_id, last_boosted_at);
create index if not exists idx_boost_slots_store on public.boost_slots (store_id);
create index if not exists idx_flash_sales_store_time on public.flash_sales (store_id, start_time desc);
create index if not exists idx_flash_sales_window on public.flash_sales (store_id, end_time);
create index if not exists idx_flash_sale_items_sale on public.flash_sale_items (flash_sale_row_id);
create index if not exists idx_flash_sale_items_store on public.flash_sale_items (store_id, item_id);
create index if not exists idx_flash_sale_slots_start on public.flash_sale_slots (start_time);

-- A7. Functions — re-asserted verbatim so their bodies match the repo exactly
--     (the new project's copies can't be read from outside). All of these RPCs
--     already exist on the new project; this guarantees they're current.

-- replace_order_items — supabase/schema.sql lines 113-131
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
-- daily_sales — supabase/sales_reporting_migration.sql lines 142-233
drop function if exists daily_sales(int);

create or replace function daily_sales(p_days int default 30)
returns table (
  day date,
  store_id uuid,
  revenue numeric,
  order_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    -- "Today" is a KL calendar day, not a UTC one.
    select (now() at time zone 'Asia/Kuala_Lumpur')::date as today_kl,
           least(greatest(coalesce(p_days, 30), 1), 365) as n_days
  ),
  days as (
    select d::date as day
    from bounds,
         generate_series(
           bounds.today_kl - (bounds.n_days - 1),
           bounds.today_kl,
           interval '1 day'
         ) d
  ),
  -- The first instant of the window, back in timestamptz, so the WHERE clause
  -- can still use the index on the date field instead of forcing a per-row
  -- timezone conversion across the whole table.
  window_start as (
    select ((bounds.today_kl - (bounds.n_days - 1))::timestamp
             at time zone 'Asia/Kuala_Lumpur') as ts
    from bounds
  ),
  scoped as (
    select (o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date as day,
           o.store_id,
           coalesce(o.total_amount, 0) as amount
    from orders o
    -- Same column as the bucket above, so the window can never prune an order
    -- the bucket would have kept, and the index on it is usable directly.
    where o.order_created_at >= (select ts from window_start)
      and (
        -- Shopee v2 order_status (SHOPEE_STATUS_MAP in src/pages/Orders.jsx)
        (o.platform = 'shopee' and o.order_status in (
          'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'
        ))
        -- Lazada, lowercase and collapsed least-progressed-wins before it is
        -- written (LAZADA_STATUS_MAP / api/_lib/lazadaSync.js). 'confirmed'
        -- counts because it means settled-but-no-fulfilment-detail, which maps
        -- to canonical 'Completed' — the same evidence that stopped it being
        -- treated as 'To Pack'. 'pending' is Lazada's To Pack and is excluded.
        or (o.platform = 'lazada' and o.order_status in (
          'packed', 'ready_to_ship', 'shipped', 'delivered', 'confirmed'
        ))
        -- TikTok Shop v202309 (TIKTOK_STATUS_MAP). That map is documented-but-
        -- unverified against live data, so this list inherits the same caveat;
        -- it is still strictly better than the accidental COMPLETED-only match
        -- it replaces.
        or (o.platform = 'tiktok' and o.order_status in (
          'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'
        ))
      )
  )
  -- per store, zero-filled across every store the caller owns
  select g.day,
         g.store_id,
         coalesce(sum(sc.amount), 0)::numeric as revenue,
         count(sc.day)::bigint as order_count
  from (select d.day, s.id as store_id from days d cross join stores s) g
  left join scoped sc
    on sc.day = g.day and sc.store_id = g.store_id
  group by g.day, g.store_id

  union all

  -- combined across all of the caller's stores; store_id IS NULL marks it
  select d.day,
         null::uuid,
         coalesce(sum(sc.amount), 0)::numeric,
         count(sc.day)::bigint
  from days d
  left join scoped sc on sc.day = d.day
  group by d.day

  -- Ordinals, not names: `day` and `store_id` are also the RETURNS TABLE
  -- column names, and an unqualified reference after a UNION is the one place
  -- that could read as ambiguous. Positions cannot.
  order by 1, 2 nulls first;
$$;
-- sales_coverage — supabase/sales_reporting_migration.sql lines 247-277
drop function if exists sales_coverage();

create or replace function sales_coverage()
returns table (
  store_id uuid,
  first_order_day date,
  last_order_day date,
  order_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select o.store_id,
         min((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         max((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         count(*)::bigint
  from orders o
  where o.order_created_at is not null
  group by o.store_id

  union all

  select null::uuid,
         min((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         max((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         count(*)::bigint
  from orders o
  where o.order_created_at is not null;
$$;
-- actionable_order_rows — supabase/actionable_orders_migration.sql lines 139-198
drop function if exists actionable_order_rows(int);

create or replace function actionable_order_rows(p_days int default 2)
returns table (
  o_id uuid,
  o_store_id uuid,
  o_platform text,
  o_platform_order_id text,
  o_status text,
  o_payment_method text,
  o_amount numeric,
  o_created_at timestamptz,
  bucket_field text,
  bucket_at timestamptz,
  bucket_day date
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select (now() at time zone 'Asia/Kuala_Lumpur')::date as today_kl,
           least(greatest(coalesce(p_days, 2), 1), 30) as n_days
  ),
  window_start as (
    select ((bounds.today_kl - (bounds.n_days - 1))::timestamp
             at time zone 'Asia/Kuala_Lumpur') as ts
    from bounds
  )
  select o.id,
         o.store_id,
         o.platform,
         o.platform_order_id,
         o.order_status,
         o.payment_method,
         coalesce(o.total_amount, 0)::numeric,
         o.order_created_at,
         'order_created_at'::text,
         o.order_created_at,
         (o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date
  from orders o
  where o.order_created_at >= (select ts from window_start)
    -- (1) CANCELLED is never counted, paid or not.
    and not (
      (o.platform = 'shopee' and o.order_status = 'CANCELLED')
      or (o.platform = 'tiktok' and o.order_status = 'CANCELLED')
      or (o.platform = 'lazada' and o.order_status in ('canceled', 'failed'))
    )
    -- (2) Among what's left, exclude UNPAID orders that aren't COD.
    -- Everything else — including UNPAID + COD — counts.
    and not (
      (
        (o.platform = 'shopee' and o.order_status = 'UNPAID')
        or (o.platform = 'tiktok' and o.order_status in ('UNPAID', 'ON_HOLD'))
        or (o.platform = 'lazada' and o.order_status = 'unpaid')
      )
      and lower(trim(o.payment_method)) not in ('cash on delivery', 'cod')
    );
$$;
-- todays_actionable_orders — supabase/actionable_orders_migration.sql lines 204-259
drop function if exists todays_actionable_orders(int);

create or replace function todays_actionable_orders(p_days int default 2)
returns table (
  day date,
  store_id uuid,
  revenue numeric,
  order_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select (now() at time zone 'Asia/Kuala_Lumpur')::date as today_kl,
           least(greatest(coalesce(p_days, 2), 1), 30) as n_days
  ),
  days as (
    select d::date as day
    from bounds,
         generate_series(
           bounds.today_kl - (bounds.n_days - 1),
           bounds.today_kl,
           interval '1 day'
         ) d
  ),
  scoped as (
    select r.bucket_day as day,
           r.o_store_id as store_id,
           r.o_amount as amount
    from actionable_order_rows(p_days) r
  )
  -- per store, zero-filled across every store the caller owns
  select g.day,
         g.store_id,
         coalesce(sum(sc.amount), 0)::numeric as revenue,
         count(sc.day)::bigint as order_count
  from (select d.day, s.id as store_id from days d cross join stores s) g
  left join scoped sc
    on sc.day = g.day and sc.store_id = g.store_id
  group by g.day, g.store_id

  union all

  -- combined across all of the caller's stores; store_id IS NULL marks it
  select d.day,
         null::uuid,
         coalesce(sum(sc.amount), 0)::numeric,
         count(sc.day)::bigint
  from days d
  left join scoped sc on sc.day = d.day
  group by d.day

  order by 1, 2 nulls first;
$$;
-- actionable_orders_for_day — supabase/actionable_orders_migration.sql lines 271-310
drop function if exists actionable_orders_for_day(date, uuid);

create or replace function actionable_orders_for_day(p_day date, p_store_id uuid default null)
returns table (
  order_id uuid,
  store_id uuid,
  platform text,
  shop_name text,
  platform_order_id text,
  order_status text,
  payment_method text,
  amount numeric,
  order_created_at timestamptz,
  bucket_field text,
  bucket_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select r.o_id,
         r.o_store_id,
         r.o_platform,
         coalesce(nullif(s.shop_name, ''), s.shop_id::text),
         r.o_platform_order_id,
         r.o_status,
         r.o_payment_method,
         r.o_amount,
         r.o_created_at,
         r.bucket_field,
         r.bucket_at
  from actionable_order_rows(
         (now() at time zone 'Asia/Kuala_Lumpur')::date - p_day + 1
       ) r
  left join stores s on s.id = r.o_store_id
  where r.bucket_day = p_day
    and (p_store_id is null or r.o_store_id = p_store_id)
  order by r.bucket_at desc, r.o_id;
$$;
-- ============================================================================
-- PART C — SECURITY
-- ============================================================================

-- C1. Row Level Security ON for every table the app owns.
do $$
declare t text;
begin
  foreach t in array array[
    'stores','orders','order_items','products','sync_logs',
    'boost_rotation','boost_slots',
    'flash_sales','flash_sale_items','flash_sale_slots',
    'logistics_channel_audit','push_subscriptions',
    'tiktok_shops','lazada_shops'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- C2. Drop EVERY existing policy on those tables, then recreate the canonical
--     set below. This removes any stray permissive policy (e.g. "using (true)")
--     that couldn't be seen from outside, and makes the result identical on
--     every run.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in (
        'stores','orders','order_items','products','sync_logs',
        'boost_rotation','boost_slots',
        'flash_sales','flash_sale_items','flash_sale_slots',
        'logistics_channel_audit','push_subscriptions',
        'tiktok_shops','lazada_shops'
      )
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- C3. Policies (same names and predicates as supabase/rls.sql and the
--     flash-deals / logistics migrations).

-- stores: own rows only
create policy "stores_select_own" on public.stores for select using (user_id = auth.uid());
create policy "stores_insert_own" on public.stores for insert with check (user_id = auth.uid());
create policy "stores_update_own" on public.stores for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "stores_delete_own" on public.stores for delete using (user_id = auth.uid());

-- Tables scoped by store_id -> a store the caller owns. Writes from the cron use
-- the service-role key, which bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array[
    'orders','products','sync_logs','boost_rotation','boost_slots','flash_sales','flash_sale_items'
  ] loop
    execute format($f$create policy %1$I on public.%2$I for select using (
      exists (select 1 from public.stores where stores.id = %2$I.store_id and stores.user_id = auth.uid()))$f$,
      t || '_select_own', t);
    execute format($f$create policy %1$I on public.%2$I for insert with check (
      exists (select 1 from public.stores where stores.id = %2$I.store_id and stores.user_id = auth.uid()))$f$,
      t || '_insert_own', t);
    execute format($f$create policy %1$I on public.%2$I for update using (
      exists (select 1 from public.stores where stores.id = %2$I.store_id and stores.user_id = auth.uid()))
      with check (
      exists (select 1 from public.stores where stores.id = %2$I.store_id and stores.user_id = auth.uid()))$f$,
      t || '_update_own', t);
    execute format($f$create policy %1$I on public.%2$I for delete using (
      exists (select 1 from public.stores where stores.id = %2$I.store_id and stores.user_id = auth.uid()))$f$,
      t || '_delete_own', t);
  end loop;
end $$;

-- order_items: via the parent order's store
create policy "order_items_select_own" on public.order_items for select using (
  exists (select 1 from public.orders join public.stores on stores.id = orders.store_id
          where orders.id = order_items.order_id and stores.user_id = auth.uid()));
create policy "order_items_insert_own" on public.order_items for insert with check (
  exists (select 1 from public.orders join public.stores on stores.id = orders.store_id
          where orders.id = order_items.order_id and stores.user_id = auth.uid()));
create policy "order_items_update_own" on public.order_items for update using (
  exists (select 1 from public.orders join public.stores on stores.id = orders.store_id
          where orders.id = order_items.order_id and stores.user_id = auth.uid()))
  with check (
  exists (select 1 from public.orders join public.stores on stores.id = orders.store_id
          where orders.id = order_items.order_id and stores.user_id = auth.uid()));
create policy "order_items_delete_own" on public.order_items for delete using (
  exists (select 1 from public.orders join public.stores on stores.id = orders.store_id
          where orders.id = order_items.order_id and stores.user_id = auth.uid()));

-- flash_sale_slots: shop-independent reference data; any signed-in user may read.
create policy "flash_sale_slots_select_all" on public.flash_sale_slots
  for select using (auth.uid() is not null);

-- logistics_channel_audit: read own history only. Deliberately no write policy —
-- the audit trail is append-only and written by the server (service role).
create policy "logistics_channel_audit_select_own" on public.logistics_channel_audit for select using (
  exists (select 1 from public.stores where stores.id = logistics_channel_audit.store_id and stores.user_id = auth.uid()));

-- push_subscriptions: a user manages only their own devices (src/lib/push.js
-- upserts and deletes from the browser; the cron reads via service role).
create policy "push_subscriptions_select_own" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "push_subscriptions_insert_own" on public.push_subscriptions for insert with check (user_id = auth.uid());
create policy "push_subscriptions_update_own" on public.push_subscriptions for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_subscriptions_delete_own" on public.push_subscriptions for delete using (user_id = auth.uid());

-- tiktok_shops / lazada_shops: NO policies on purpose. They hold platform
-- access/refresh tokens and the browser never touches them (verified: no
-- supabase.from('tiktok_shops'|'lazada_shops') in src/). RLS on + no policy =
-- denied to anon and authenticated; only the service-role server can read them.

-- C4. Defense in depth: even if RLS is ever switched off again, anon must not be
--     able to touch data. Nothing in the app uses the anon role against tables
--     (the browser is always signed in => "authenticated"; the server uses the
--     service role, which is unaffected).
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from public;

-- Re-grant exactly what's used: the four reporting RPCs are called by the
-- signed-in browser; replace_order_items only by the server.
grant execute on function public.daily_sales(int)                      to authenticated, service_role;
grant execute on function public.sales_coverage()                      to authenticated, service_role;
grant execute on function public.todays_actionable_orders(int)         to authenticated, service_role;
grant execute on function public.actionable_order_rows(int)            to authenticated, service_role;
grant execute on function public.actionable_orders_for_day(date, uuid) to authenticated, service_role;
grant execute on function public.replace_order_items(uuid[], jsonb)    to service_role;

-- OPTIONAL (uncomment): make future tables anon-proof by default, so a new table
-- created without RLS can't repeat this incident.
-- alter default privileges in schema public revoke all on tables from anon;

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- VERIFY (run after; expect rls_enabled = true on every row; policies = 0 only
-- for tiktok_shops and lazada_shops, which is intentional)
-- ============================================================================
-- select c.relname as tbl, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r' order by 1;
