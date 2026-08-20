-- ============================================================================
-- Actionable-orders migration — run once in the Supabase SQL editor.
-- Idempotent: safe to re-run.
--
-- Adds one read-only aggregate function powering the Dashboard's "Orders
-- Today" and "Revenue" tiles. No table changes, no data migration.
--
-- This is a DIFFERENT question from daily_sales() (sales_reporting_migration.sql):
-- daily_sales() answers "how much confirmed revenue has this order set
-- progressed to" for the Sales page's 30-day trend, and deliberately EXCLUDES
-- unpaid and to-pack orders. This function answers "what does the seller need
-- to look at today" and deliberately INCLUDES some money not yet received.
-- Folding this into daily_sales() would have made the 30-day trend include
-- unconfirmed cash — kept separate on purpose. See salesReport.js.
--
-- SECURITY INVOKER (not DEFINER): same reasoning as daily_sales() — orders and
-- stores carry user-scoped RLS, so a DEFINER function here would leak revenue
-- across accounts.
-- ============================================================================

-- Already created by sales_reporting_migration.sql; included here too so this
-- file is runnable standalone.
create index if not exists idx_orders_created_at
  on orders (order_created_at);

-- ---------------------------------------------------------------------------
-- todays_actionable_orders(p_days)
--
-- Same shape as daily_sales(): one row per (day, store) plus one combined row
-- per day where store_id IS NULL. Called with the default 2-day window so the
-- Dashboard's "Today" value and its "Yesterday" sub-line come from the SAME
-- query and can never disagree with each other.
--
-- An order counts when it was created on the given KL calendar day AND EITHER:
--   (a) UNPAID, with payment_method a Cash-on-Delivery variant, OR
--   (b) sitting in the "New Orders" tab (STATUS_TO_TAB's 'new' bucket in
--       src/pages/Orders.jsx: canonical Invoice Pending + To Pack),
--       regardless of payment method.
-- (a) and (b) can't both be true for the same order in today's status maps
-- (Unpaid and Invoice-Pending/To-Pack are disjoint canonical statuses), but OR
-- is used rather than relying on that, so a future status remap can't
-- silently double-count a row.
--
-- COD PAYMENT_METHOD STRINGS — audited against live data on 2026-08-20.
-- orders.payment_method has no enum or CHECK constraint; it's free text,
-- populated verbatim by each platform's sync (api/_lib/*Sync.js). Matched
-- case-insensitively so the three platform spellings of the same real-world
-- payment method are all covered by one rule:
--   Shopee:  'Cash on Delivery'      (479 live rows)
--   TikTok:  'Cash on delivery'      (28 live rows — lowercase 'd')
--   Lazada:  'COD'                   (53 live rows — no long-form string exists)
-- Deliberately EXCLUDES Shopee's 'Cash Payment at Physical Stores' (117 live
-- rows) — a real but DIFFERENT payment method (in-store cash, not
-- cash-on-parcel-delivery) that must never be counted as COD.
--
-- NEW-ORDERS-TAB STATUSES — mirrors STATUS_TO_TAB's 'new' bucket via
-- SHOPEE_STATUS_MAP / TIKTOK_STATUS_MAP / LAZADA_STATUS_MAP in
-- src/lib/orderStatus.js:
--   Shopee:  INVOICE_PENDING, READY_TO_SHIP
--   TikTok:  AWAITING_SHIPMENT
--   Lazada:  pending
-- NOT Lazada's 'ready_to_ship' — that raw string maps to canonical Packed, not
-- To Pack (see the FALSE FRIEND note in daily_sales(), sales_reporting_migration.sql);
-- it is deliberately absent here for the same reason.
--
-- TIMEZONE / DATE FIELD / row-cap rationale: identical to daily_sales() —
-- order_created_at (timestamptz) bucketed via `at time zone 'Asia/Kuala_Lumpur'`,
-- never a naive ::date cast, and aggregated in Postgres so the client never
-- sums a select that PostgREST would cap at 1,000 rows.
-- ---------------------------------------------------------------------------
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
      and (
        -- (a) UNPAID + Cash on Delivery, any platform
        (
          lower(trim(o.payment_method)) in ('cash on delivery', 'cod')
          and (
            (o.platform = 'shopee' and o.order_status = 'UNPAID')
            or (o.platform = 'tiktok' and o.order_status in ('UNPAID', 'ON_HOLD'))
            or (o.platform = 'lazada' and o.order_status = 'unpaid')
          )
        )
        -- (b) New Orders tab, any payment method
        or (
          (o.platform = 'shopee' and o.order_status in ('INVOICE_PENDING', 'READY_TO_SHIP'))
          or (o.platform = 'tiktok' and o.order_status = 'AWAITING_SHIPMENT')
          or (o.platform = 'lazada' and o.order_status = 'pending')
        )
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

  order by 1, 2 nulls first;
$$;

grant execute on function todays_actionable_orders(int) to authenticated;

-- PostgREST answers RPC calls from a cached view of the schema, so make the
-- new function callable immediately instead of after an unpredictable wait.
notify pgrst, 'reload schema';
