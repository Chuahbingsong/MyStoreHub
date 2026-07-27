-- ============================================================================
-- Sales reporting migration — run once in the Supabase SQL editor.
-- Idempotent: safe to re-run.
--
-- Adds two read-only aggregate functions. No table changes, no data migration.
--
-- WHY THESE ARE FUNCTIONS AND NOT A CLIENT-SIDE SUM:
--   orders is already 1,290 rows and growing. PostgREST silently caps an
--   unbounded select at 1,000 rows, so summing revenue in JS would quietly
--   UNDER-COUNT — the worst possible failure mode for a revenue report, because
--   it looks plausible. These functions return at most (days x (stores + 1))
--   rows — ~150 — which is structurally immune to that cap.
--
-- SECURITY INVOKER (not DEFINER) is deliberate: both `orders` and `stores`
-- carry user-scoped RLS, so running as the caller means a user can only ever
-- aggregate their own stores' orders. A DEFINER function here would bypass RLS
-- and leak revenue across accounts.
-- ============================================================================

-- Supports the window filter below. orders currently has no index on
-- order_created_at (only store_id+order_status and platform_order_id), so the
-- 30-day scan would otherwise be a seq scan on every page load.
create index if not exists idx_orders_created_at
  on orders (order_created_at);

-- ---------------------------------------------------------------------------
-- daily_sales(p_days)
--
-- Returns one row per (day, store) PLUS one combined row per day where
-- store_id IS NULL. Both shapes are aggregated in Postgres, so the client never
-- sums anything.
--
-- TIMEZONE — the thing most likely to be got wrong later:
--   order_created_at is timestamptz. A naive ::date cast would bucket by UTC,
--   which shifts every boundary 8 hours and puts orders placed between 00:00
--   and 08:00 Malaysia time into the PREVIOUS day. On this account that is
--   162 of 1,290 orders (12.6%) landing on the wrong day, and it makes
--   "yesterday" simply wrong.
--   `order_created_at at time zone 'Asia/Kuala_Lumpur'` converts the
--   timestamptz to local wall-clock time in KL; ::date then takes the KL
--   calendar day. Named zone, not a hardcoded +8, so it stays correct if
--   Malaysia ever observes DST again (it did until 1935).
--
-- WHAT COUNTS AS A SALE:
--   PROCESSED, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED, RETRY_SHIP.
--   Deliberately EXCLUDED: UNPAID (cash-at-counter orders that mostly never
--   get paid — counting them inflates revenue), CANCELLED, IN_CANCEL,
--   TO_RETURN.
--
-- DATE FIELD:
--   order_created_at, NOT paid_at. paid_at is null on 166 of 1,290 orders
--   (12.9%) because Shopee returns pay_time: 0, so keying on it would silently
--   drop an eighth of all revenue.
--
-- Days with no sales come back as zeros rather than missing rows, so the chart
-- has no phantom gaps and the caller never has to fill them.
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
  -- The first instant of the window, back in timestamptz, so the WHERE clause
  -- can still use the index on order_created_at instead of forcing a per-row
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
    where o.order_created_at >= (select ts from window_start)
      and o.order_status in (
        'PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'RETRY_SHIP'
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

-- ---------------------------------------------------------------------------
-- sales_coverage()
--
-- How far back the order history actually goes, per store and overall
-- (store_id IS NULL). The report window is a fixed 30 days, but the DATA only
-- goes back as far as has been synced — so the UI can say "history starts
-- 18 Jun" instead of drawing 10 days of misleading zeros that look like days
-- with no sales.
--
-- Deliberately NOT status-filtered: this answers "how far back does the record
-- go", which is about sync coverage, not about which orders count as revenue.
-- ---------------------------------------------------------------------------
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

-- Both functions are RLS-scoped via security invoker; `authenticated` is the
-- only role that needs them.
grant execute on function daily_sales(int) to authenticated;
grant execute on function sales_coverage() to authenticated;
