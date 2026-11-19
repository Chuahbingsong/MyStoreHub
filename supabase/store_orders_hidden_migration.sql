-- ============================================================================
-- Per-store "Hide orders" (stores.orders_hidden).
--
-- A hidden store stays connected and keeps syncing; its orders are only left
-- out of what the app SHOWS. Every revenue/count figure is computed here in
-- Postgres, so the exclusion lives here too — the browser never filters a
-- total. Unhiding is just flipping the flag back: nothing is deleted or
-- re-synced, so every figure returns immediately.
--
-- WHAT THIS DOES
--   A. stores.orders_hidden boolean not null default false.
--   B. actionable_order_rows()    — skips orders of hidden stores. This is THE
--      rule, so todays_actionable_orders() (Dashboard tiles + platform cards),
--      daily_sales() (Sales page, which returns todays_actionable_orders()
--      unchanged) and actionable_orders_for_day() (Revenue breakdown) all
--      follow without being edited.
--   C. todays_actionable_orders() — also drops hidden stores from its
--      zero-filled per-store rows, so a hidden store contributes no series.
--   D. sales_coverage()           — hidden stores no longer stretch the
--      Sales page's "history starts on" date.
--
-- RLS: stores' existing row policies (user_id = auth.uid(), for select AND
-- update) already cover every column of the row, orders_hidden included —
-- there are no column-level grants on stores. Nothing to add.
--
-- Scan deliberately does NOT go through any of these functions (it reads
-- orders directly), so a parcel from a hidden store still resolves.
--
-- Bodies B–D are the current definitions (identical in
-- actionable_orders_migration.sql, website_platform_migration.sql,
-- new_project_migration.sql, sales_reporting_migration.sql and schema.sql)
-- with ONLY the lines marked `-- HIDDEN:` added. Re-running any of those
-- older files would silently bring hidden stores' orders back into the
-- totals; re-run this file afterwards if you ever do.
--
-- Safe with the frontend that is live now (same names, arguments and return
-- shapes; the new column defaults to false). Idempotent. Run in the SQL editor
-- of the NEW project BEFORE deploying the frontend that reads orders_hidden.
-- ============================================================================
begin;

-- A. --------------------------------------------------------------------------
alter table stores add column if not exists orders_hidden boolean not null default false;

comment on column stores.orders_hidden is
  'When true the store keeps syncing but its orders are hidden from the app (Orders, Dashboard, Sales, Revenue breakdown, Bulk print, push). Scan still finds them.';

-- B. --------------------------------------------------------------------------
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
  join stores hs on hs.id = o.store_id                       -- HIDDEN:
  where not hs.orders_hidden                                 -- HIDDEN:
    and o.order_created_at >= (select ts from window_start)
    -- (1) CANCELLED is never counted, paid or not.
    and not (
      (o.platform = 'shopee' and o.order_status = 'CANCELLED')
      or (o.platform = 'tiktok' and o.order_status = 'CANCELLED')
      or (o.platform = 'lazada' and o.order_status in ('canceled', 'failed'))
      or (o.platform = 'website' and o.order_status in ('cancelled', 'refunded'))
    )
    -- (2) Among what's left, exclude UNPAID orders that aren't COD.
    and not (
      (
        (o.platform = 'shopee' and o.order_status = 'UNPAID')
        or (o.platform = 'tiktok' and o.order_status in ('UNPAID', 'ON_HOLD'))
        or (o.platform = 'lazada' and o.order_status = 'unpaid')
      )
      and lower(trim(o.payment_method)) not in ('cash on delivery', 'cod')
    );
$$;

-- C. --------------------------------------------------------------------------
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
  -- per store, zero-filled across every VISIBLE store the caller owns
  select g.day,
         g.store_id,
         coalesce(sum(sc.amount), 0)::numeric as revenue,
         count(sc.day)::bigint as order_count
  from (
    select d.day, s.id as store_id
    from days d cross join stores s
    where not s.orders_hidden                                -- HIDDEN:
  ) g
  left join scoped sc
    on sc.day = g.day and sc.store_id = g.store_id
  group by g.day, g.store_id

  union all

  -- combined across all of the caller's stores; store_id IS NULL marks it
  -- (scoped already excludes hidden stores)
  select d.day,
         null::uuid,
         coalesce(sum(sc.amount), 0)::numeric,
         count(sc.day)::bigint
  from days d
  left join scoped sc on sc.day = d.day
  group by d.day

  order by 1, 2 nulls first;
$$;

-- D. --------------------------------------------------------------------------
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
  join stores hs on hs.id = o.store_id                       -- HIDDEN:
  where o.order_created_at is not null
    and not hs.orders_hidden                                 -- HIDDEN:
  group by o.store_id

  union all

  select null::uuid,
         min((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         max((o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date),
         count(*)::bigint
  from orders o
  join stores hs on hs.id = o.store_id                       -- HIDDEN:
  where o.order_created_at is not null
    and not hs.orders_hidden;                                -- HIDDEN:
$$;

-- `create or replace` keeps existing grants; restated so a fresh project works.
grant execute on function actionable_order_rows(int) to authenticated;
grant execute on function todays_actionable_orders(int) to authenticated;
grant execute on function sales_coverage() to authenticated;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (optional, read-only). Run as yourself in the SQL editor's
-- "authenticated" role, or just eyeball the column:
-- ============================================================================
-- select id, platform, shop_name, orders_hidden from stores order by platform;
