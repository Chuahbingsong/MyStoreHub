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
-- unpaid and to-pack orders. This function answers "what happened today" —
-- effectively ALL of today's orders — and deliberately INCLUDES some money
-- not yet received (unpaid COD). Folding this into daily_sales() would have
-- made the 30-day trend include unconfirmed cash — kept separate on purpose.
-- See salesReport.js.
--
-- SECURITY INVOKER (not DEFINER): same reasoning as daily_sales() — orders and
-- stores carry user-scoped RLS, so a DEFINER function here would leak revenue
-- across accounts.
-- ============================================================================

-- Already created by sales_reporting_migration.sql; included here too so this
-- file is runnable standalone.
create index if not exists idx_orders_created_at
  on orders (order_created_at);

-- Supports the bucketing/window change below: the day an order counts on is
-- now keyed off paid_at first, so a query pruning on that column needs an
-- index on it too, not just order_created_at.
create index if not exists idx_orders_paid_at
  on orders (paid_at);

-- ---------------------------------------------------------------------------
-- todays_actionable_orders(p_days)
--
-- Same shape as daily_sales(): one row per (day, store) plus one combined row
-- per day where store_id IS NULL. Called with the default 2-day window so the
-- Dashboard's "Today" value and its "Yesterday" sub-line come from the SAME
-- query and can never disagree with each other.
--
-- DATE FIELD — PAYMENT date, not order date (changed 2026-08-24):
-- an order buckets on coalesce(paid_at, order_created_at), not plain
-- order_created_at. Intent: "orders paid today", so a COD order collected
-- today counts today even if it was placed days earlier, across every
-- payment method (not just cash-at-counter).
--
-- The coalesce to order_created_at is NOT a cosmetic fallback, it is load-
-- bearing — paid_at is null far more often than it's an edge case:
--   - Lazada: paid_at is ALWAYS null. Lazada's order API has no payment-time
--     field at all (see the mapping comment in api/_lib/lazadaSync.js) — this
--     is a permanent platform gap, not a sync bug, so every Lazada order
--     falls back to order_created_at indefinitely.
--   - COD (any platform), while still in fulfilment: Shopee/TikTok only set
--     paid_at once the order reaches COMPLETED/DELIVERED/TO_CONFIRM_RECEIVE —
--     i.e. when the platform confirms cash was collected, NOT when it ships.
--     Audited against live data on 2026-08-24: median 2 days, up to 9, after
--     order_created_at, and orders still sitting in SHIPPED/PROCESSED have no
--     paid_at yet. Those fall back to order_created_at until they complete.
--   - Non-COD Shopee/TikTok: paid_at is set same-day as order_created_at
--     (0% null in the same audit), so the coalesce is a no-op for these —
--     switching to paid_at changes nothing here.
-- Net effect of this change: it's a no-op for Lazada, a no-op for in-flight
-- COD, a no-op for non-COD orders, and reassigns a COMPLETED COD order from
-- its order-day to its completion-day. That reassignment is retroactive: an
-- order counted today via the order_created_at fallback (paid_at still null)
-- can, days later once the platform sets paid_at, silently move to a
-- different day's bucket on the next query — so a past day's total read here
-- is not guaranteed stable if re-queried later. Accepted trade for "paid
-- today" being literally true; do not build reconciliation against historical
-- reads of this function without accounting for that drift.
--
-- RULE (status filter — unchanged by the above, still status-based, not
-- date-based): an order counts when its (now payment-)day falls in the
-- window, AND it is NOT excluded by either of these:
--   (1) CANCELLED — never counted, paid or not. A cancelled order converts to
--       no money kept: if it was paid, the payment is refunded; if it was
--       unpaid, it was never going to be paid. Counting it would contradict
--       daily_sales() above, which has never counted cancellations either.
--   (2) UNPAID and NOT Cash-on-Delivery — cash-at-counter / bank-transfer /
--       e-wallet orders that were never paid mostly never get paid, so
--       counting them inflates both the order count and the revenue figure.
-- Every other status counts regardless of payment method — including UNPAID
-- + COD, which is money not yet physically received but a real, fulfillable
-- order (see the revenue-tile wording in src/lib/i18n and Dashboard.jsx).
--
-- Deliberately NOT excluded here despite carrying similar risk: Cancel
-- Requested, Return Requested, Returned. Only CANCELLED was asked for; those
-- three stay INCLUDED under the "everything else counts" rule until told
-- otherwise.
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
-- CANCELLED STATUSES — mirrors canonical Cancelled via SHOPEE_STATUS_MAP /
-- TIKTOK_STATUS_MAP / LAZADA_STATUS_MAP in src/lib/orderStatus.js:
--   Shopee:  CANCELLED
--   TikTok:  CANCELLED
--   Lazada:  canceled, failed  ('failed' is Lazada's weakest mapping — see the
--            long note on it in orderStatus.js — but it is canonically
--            Cancelled today, so it's excluded here for the same reason
--            literal CANCELLED is)
-- UNPAID STATUSES — same canonical mapping, used only to find which of
-- today's orders are unpaid so the COD carve-out can be applied to them:
--   Shopee:  UNPAID
--   TikTok:  UNPAID, ON_HOLD
--   Lazada:  unpaid
--
-- TIMEZONE: identical to daily_sales() — bucketed via
-- `at time zone 'Asia/Kuala_Lumpur'`, never a naive ::date cast, and
-- aggregated in Postgres so the client never sums a select that PostgREST
-- would cap at 1,000 rows.
--
-- DATE FIELD used for both the bucket AND the window filter is
-- coalesce(o.paid_at, o.order_created_at) — see the long note above. The
-- window filter has to use the SAME coalesced expression as the bucket, not
-- order_created_at: a COD order created up to 9 days ago can have paid_at
-- fall inside today's window, and filtering on order_created_at alone would
-- exclude it from the scan before the bucket logic ever sees it, silently
-- dropping a payment that landed today.
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
    select (coalesce(o.paid_at, o.order_created_at) at time zone 'Asia/Kuala_Lumpur')::date as day,
           o.store_id,
           coalesce(o.total_amount, 0) as amount
    from orders o
    where coalesce(o.paid_at, o.order_created_at) >= (select ts from window_start)
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
