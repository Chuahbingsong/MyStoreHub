-- ============================================================================
-- One counting rule for every revenue figure.
--
-- daily_sales() (Sales page) now counts exactly the orders
-- actionable_order_rows() does — everything EXCEPT cancelled orders and unpaid
-- orders that aren't COD. So To Pack, unpaid COD, returns and cancel requests
-- all count, the same as the Revenue breakdown list and the Dashboard tiles.
--
-- It does that by returning todays_actionable_orders() unchanged, not by
-- carrying a copy of the filter: the rule still lives only in
-- actionable_order_rows() (supabase/actionable_orders_migration.sql, website
-- clause in website_platform_migration.sql section E), and every reader sums
-- or lists those rows:
--
--   daily_sales()               Sales page chart/table   -> todays_actionable_orders()
--   todays_actionable_orders()  Dashboard tiles          -> actionable_order_rows()
--   actionable_orders_for_day() Revenue breakdown list   -> actionable_order_rows()
--
-- A Sales row therefore equals the breakdown total for the same day and store
-- by construction — and today's Sales bar equals the Dashboard Revenue tile.
--
-- WINDOW CAP: daily_sales() used to accept up to 365 days; it now inherits
-- todays_actionable_orders()' 30-day cap. The app only ever asks for 30
-- (SALES_WINDOW_DAYS in src/lib/salesReport.js).
--
-- Supersedes supabase/sales_breakdown_migration.sql (commit eddbad6), which is
-- removed from the repo. Its two functions are dropped in STEP 2.
--
-- NOTE: sales_reporting_migration.sql, website_platform_migration.sql (D) and
-- new_project_migration.sql each still contain the OLD paid-and-packed
-- daily_sales() body. Re-running any of them would quietly bring the old rule
-- back — re-run this file afterwards if you ever do.
--
-- Run in the SQL editor of the NEW project. Both steps are idempotent.
-- ============================================================================


-- ============================================================================
-- STEP 1 — run BEFORE deploying the frontend. Safe with the frontend that is
-- live now: same function name, arguments and return shape.
-- ============================================================================
begin;

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
  select t.day, t.store_id, t.revenue, t.order_count
  from todays_actionable_orders(p_days) t;
$$;

grant execute on function daily_sales(int) to authenticated;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- STEP 2 — run AFTER the new frontend is deployed. The frontend live now
-- (commit eddbad6) still calls sales_orders_for_day() when the breakdown is
-- opened from the Sales page; dropping it earlier breaks that page until the
-- deploy lands. Harmless if sales_breakdown_migration.sql was never run.
-- ============================================================================
-- begin;
--
-- drop function if exists sales_orders_for_day(date, uuid);
-- drop function if exists sales_order_rows(int);
--
-- commit;
--
-- notify pgrst, 'reload schema';
