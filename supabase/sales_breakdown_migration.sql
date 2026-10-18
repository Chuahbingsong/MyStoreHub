-- ============================================================================
-- Sales-rule order list for the Revenue breakdown page.
--
-- The breakdown page now follows whichever page opened it:
--   - from a Sales day row  -> that day's daily_sales() orders (this file)
--   - otherwise (default)   -> actionable_orders_for_day(), unchanged
--
-- Same pattern as supabase/actionable_orders_migration.sql: THE RULE lives in
-- exactly one place — sales_order_rows() — and both readers follow it:
--   daily_sales()          (Sales page chart/table)  aggregates it
--   sales_orders_for_day() (breakdown, sales basis)   lists one day of it
-- so a Sales row and the list it opens cannot disagree on which orders count.
--
-- daily_sales() keeps its exact signature and return shape — the body is only
-- rewritten to sum sales_order_rows() instead of carrying its own filter. The
-- status lists below are copied verbatim from its current definition in
-- supabase/website_platform_migration.sql section D; every note there (why
-- 'paid' counts for website, why Lazada 'confirmed' counts, the TikTok caveat)
-- still applies.
--
-- Paste into the SQL editor of the NEW project and run. Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- sales_order_rows(p_days) — every order daily_sales() counts, one row each,
-- within the last p_days KL days (clamped to 1..365, daily_sales' own cap).
-- ---------------------------------------------------------------------------
drop function if exists sales_order_rows(int);

create or replace function sales_order_rows(p_days int default 30)
returns table (
  o_id uuid,
  o_store_id uuid,
  o_platform text,
  o_platform_order_id text,
  o_status text,
  o_payment_method text,
  o_amount numeric,
  o_created_at timestamptz,
  bucket_day date
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select (now() at time zone 'Asia/Kuala_Lumpur')::date as today_kl,
           least(greatest(coalesce(p_days, 30), 1), 365) as n_days
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
         (o.order_created_at at time zone 'Asia/Kuala_Lumpur')::date
  from orders o
  where o.order_created_at >= (select ts from window_start)
    and (
      (o.platform = 'shopee' and o.order_status in (
        'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'
      ))
      or (o.platform = 'lazada' and o.order_status in (
        'packed', 'ready_to_ship', 'shipped', 'delivered', 'confirmed'
      ))
      or (o.platform = 'tiktok' and o.order_status in (
        'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'
      ))
      or (o.platform = 'website' and o.order_status in (
        'paid', 'shipped'
      ))
    );
$$;

-- ---------------------------------------------------------------------------
-- daily_sales(p_days) — same signature and output as before; now a pure
-- aggregate of sales_order_rows(), carrying no filter of its own.
-- ---------------------------------------------------------------------------
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
  scoped as (
    select r.bucket_day as day,
           r.o_store_id as store_id,
           r.o_amount as amount
    from sales_order_rows(p_days) r
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

-- ---------------------------------------------------------------------------
-- sales_orders_for_day(p_day, p_store_id) — the breakdown list, sales basis.
-- Same return shape as actionable_orders_for_day() so the client maps both
-- the same way. Bounded in the database to one KL day (and one store, if
-- given). A day outside daily_sales' 365-day cap returns no rows.
-- ---------------------------------------------------------------------------
drop function if exists sales_orders_for_day(date, uuid);

create or replace function sales_orders_for_day(p_day date, p_store_id uuid default null)
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
         'order_created_at'::text,
         r.o_created_at
  from sales_order_rows(
         (now() at time zone 'Asia/Kuala_Lumpur')::date - p_day + 1
       ) r
  left join stores s on s.id = r.o_store_id
  where r.bucket_day = p_day
    and (p_store_id is null or r.o_store_id = p_store_id)
  order by r.o_created_at desc, r.o_id;
$$;

grant execute on function sales_order_rows(int) to authenticated;
grant execute on function daily_sales(int) to authenticated;
grant execute on function sales_orders_for_day(date, uuid) to authenticated;

-- Same lockdown the other RPCs have in the new project: nothing for anon.
revoke execute on function sales_order_rows(int) from anon, public;
revoke execute on function sales_orders_for_day(date, uuid) from anon, public;

commit;

notify pgrst, 'reload schema';
