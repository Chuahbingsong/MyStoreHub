-- ============================================================================
-- Verification for supabase/website_platform_migration.sql.
--
-- Run this in the Supabase SQL editor of the SAME (new) project immediately
-- after the migration, and before any code is deployed. It is READ-ONLY: the
-- one section that writes rows (section 6) does so inside a transaction that
-- is rolled back, so nothing survives it.
--
-- Every check raises an exception on failure, so a clean run that reaches the
-- final notice means all of it passed. Run it as a whole script.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The stores row (A) — exists, is owned, and there is exactly ONE of it.
--    A duplicate would silently split website orders across two stores and
--    break the Dashboard's per-store grouping.
-- ---------------------------------------------------------------------------
do $$
declare n int; owner uuid;
begin
  select count(*) into n from stores where platform = 'website';
  if n <> 1 then
    raise exception 'FAIL 1: expected exactly 1 website store, found %', n;
  end if;

  select user_id into owner from stores where platform = 'website';
  if owner is null then
    raise exception 'FAIL 1: website store has no user_id — orders would be invisible under RLS';
  end if;

  raise notice 'PASS 1: website store owned by %', owner;
end $$;

select id as website_store_id, platform, shop_id, shop_name, is_active, user_id
from stores
where platform = 'website';


-- ---------------------------------------------------------------------------
-- 2. website_webhook_events (B) — table, the UNIQUE on delivery_id that the
--    whole idempotency scheme rests on, and RLS enabled.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.website_webhook_events') is null then
    raise exception 'FAIL 2: table website_webhook_events does not exist';
  end if;

  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
    where c.relname = 'website_webhook_events'
      and i.indisunique
      and i.indnatts = 1
      and a.attname = 'delivery_id'
  ) then
    raise exception 'FAIL 2: no single-column UNIQUE index on website_webhook_events.delivery_id — retries would be processed twice';
  end if;

  if not (select relrowsecurity from pg_class where relname = 'website_webhook_events') then
    raise exception 'FAIL 2: RLS is not enabled on website_webhook_events';
  end if;

  -- Deny-all to `authenticated` is the intent, i.e. RLS on with NO policies.
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'website_webhook_events') then
    raise exception 'FAIL 2: website_webhook_events has policies — it should be service-role only (RLS on, no policies)';
  end if;

  raise notice 'PASS 2: website_webhook_events present, delivery_id unique, RLS on with no policies';
end $$;


-- ---------------------------------------------------------------------------
-- 3. orders.website_event_sent_at (C) — the out-of-order guard column.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'website_event_sent_at'
  ) then
    raise exception 'FAIL 3: orders.website_event_sent_at is missing';
  end if;
  raise notice 'PASS 3: orders.website_event_sent_at present';
end $$;


-- ---------------------------------------------------------------------------
-- 4 + 5. The two rewritten functions actually contain their website branch.
--
--    This is the check worth having: both functions existed BEFORE this
--    migration, so "the function exists" proves nothing. A migration that
--    half-ran, or an older copy of sales_reporting_migration.sql re-run
--    afterwards, leaves a function that works fine and reports website
--    revenue as zero forever. Inspecting the live definition is the only way
--    to see that from outside.
-- ---------------------------------------------------------------------------
do $$
declare def text;
begin
  select pg_get_functiondef('daily_sales(int)'::regprocedure) into def;
  if def not like '%' || quote_literal('website') || '%' then
    raise exception 'FAIL 4: live daily_sales() has no website branch — website revenue would always be 0';
  end if;
  if def not like '%' || quote_literal('paid') || '%' then
    raise exception 'FAIL 4: live daily_sales() does not count website ''paid''';
  end if;
  raise notice 'PASS 4: daily_sales() carries the website branch';

  select pg_get_functiondef('actionable_order_rows(int)'::regprocedure) into def;
  if def not like '%' || quote_literal('refunded') || '%' then
    raise exception 'FAIL 5: live actionable_order_rows() has no website exclusion — cancelled/refunded website orders would count as actionable';
  end if;
  raise notice 'PASS 5: actionable_order_rows() carries the website exclusion';
end $$;

-- Eyeball the two branches as they are actually stored.
select 'daily_sales' as fn, t.line
from regexp_split_to_table(pg_get_functiondef('daily_sales(int)'::regprocedure), E'\n') as t(line)
where t.line like '%website%'
union all
select 'actionable_order_rows', t.line
from regexp_split_to_table(pg_get_functiondef('actionable_order_rows(int)'::regprocedure), E'\n') as t(line)
where t.line like '%website%';


-- ---------------------------------------------------------------------------
-- 6. END-TO-END SMOKE TEST — a real website order, through the real functions.
--
-- ROLLED BACK at the end: nothing below is kept. This proves the thing none of
-- the checks above can, namely that a row written the way api/website.js will
-- write it actually lands in the revenue report and the Dashboard tiles.
--
-- Covers, in one pass:
--   - a 'paid' order counts as revenue (the deliberate deviation in D)
--   - a 'refunded' order does NOT count, in either function
--   - the money arrives as RINGGIT, not sen (total_cents 6280 -> 62.80). The
--     payload is integer sen and orders.total_amount is decimal(10,2); getting
--     this backwards would overstate revenue 100x, so it is asserted here
--     rather than trusted.
--   - a replayed delivery_id is rejected by the unique index
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_store_id uuid;
  v_order_id uuid;
  v_refunded_id uuid;
  v_revenue numeric;
  v_count bigint;
  v_actionable int;
  v_inserted int;
begin
  select id into v_store_id from stores where platform = 'website';

  -- Exactly the shape api/website.js will upsert for the spec's sample
  -- payload: order_no -> platform_order_id, status verbatim, total_cents/100.
  insert into orders (
    store_id, platform, platform_order_id, order_status,
    buyer_name, buyer_phone, shipping_address, region,
    total_amount, currency, payment_method,
    paid_at, order_created_at, website_event_sent_at
  ) values (
    v_store_id, 'website', 'VERIFY-CPT-00001', 'paid',
    'Verify Buyer', '0123456789', '1 Jalan Verify, 50000 Kuala Lumpur, Selangor, MY', 'Kuala Lumpur',
    6280 / 100.0, 'MYR', 'fpx',
    now(), now(), now()
  ) returning id into v_order_id;

  insert into orders (
    store_id, platform, platform_order_id, order_status,
    total_amount, currency, order_created_at
  ) values (
    v_store_id, 'website', 'VERIFY-CPT-00002', 'refunded',
    99999.00, 'MYR', now()
  ) returning id into v_refunded_id;

  -- (a) Money scale.
  if (select total_amount from orders where id = v_order_id) <> 62.80 then
    raise exception 'FAIL 6a: expected total_amount 62.80 from 6280 sen, got %',
      (select total_amount from orders where id = v_order_id);
  end if;

  -- (b) daily_sales counts the paid order, at ringgit scale, and excludes the
  --     refunded one (which would show up as a 99999 spike if it did not).
  select revenue, order_count into v_revenue, v_count
  from daily_sales(1)
  where store_id = v_store_id
    and day = (now() at time zone 'Asia/Kuala_Lumpur')::date;

  if v_count <> 1 then
    raise exception 'FAIL 6b: daily_sales counted % website order(s) today, expected 1 (the paid one; the refunded one must not count)', v_count;
  end if;
  if v_revenue <> 62.80 then
    raise exception 'FAIL 6b: daily_sales revenue was %, expected 62.80', v_revenue;
  end if;
  raise notice 'PASS 6b: daily_sales -> % order(s), revenue %', v_count, v_revenue;

  -- (c) actionable_order_rows includes the paid order and excludes the
  --     refunded one.
  select count(*) into v_actionable
  from actionable_order_rows(1)
  where o_store_id = v_store_id;

  if v_actionable <> 1 then
    raise exception 'FAIL 6c: actionable_order_rows returned % website row(s), expected 1', v_actionable;
  end if;
  if exists (select 1 from actionable_order_rows(1) where o_id = v_refunded_id) then
    raise exception 'FAIL 6c: the refunded website order is being counted as actionable';
  end if;
  raise notice 'PASS 6c: actionable_order_rows -> 1 row, refunded order excluded';

  -- (d) Idempotency: the same delivery_id twice writes once.
  insert into website_webhook_events (delivery_id, event, order_no, status, sent_at)
  values ('verify-delivery-0001', 'order.paid', 'VERIFY-CPT-00001', 'paid', now())
  on conflict (delivery_id) do nothing;

  insert into website_webhook_events (delivery_id, event, order_no, status, sent_at)
  values ('verify-delivery-0001', 'order.paid', 'VERIFY-CPT-00001', 'paid', now())
  on conflict (delivery_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted <> 0 then
    raise exception 'FAIL 6d: replaying a delivery_id inserted % row(s), expected 0', v_inserted;
  end if;
  raise notice 'PASS 6d: replayed delivery_id was a no-op';

  raise notice 'PASS 6: end-to-end smoke test clean — rolling back, nothing kept';
end $$;

rollback;


-- ---------------------------------------------------------------------------
-- 7. Proof the rollback took. Both must be 0.
-- ---------------------------------------------------------------------------
select
  (select count(*) from orders where platform_order_id like 'VERIFY-CPT-%') as leftover_orders,
  (select count(*) from website_webhook_events where delivery_id = 'verify-delivery-0001') as leftover_events;
