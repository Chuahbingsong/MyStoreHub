-- ============================================================================
-- AWB print history migration.
-- Run ONCE in the Supabase SQL editor, against the NEW project (the one Vercel
-- production points at). Idempotent: safe to re-run.
--
-- RUN THIS BEFORE DEPLOYING THE CODE. api/_lib/awbPrinted.js inserts into
-- awb_print_events on every print confirm, and the order detail sheet selects
-- from it; without this table every print confirm logs an insert error (the
-- awb_printed/awb_printed_at flags still update — the history insert is
-- deliberately non-fatal) and the sheet shows no history at all.
--
-- WHAT THIS DOES
--   A. awb_print_events — one append-only row per print, the history itself.
--   B. RLS on it, mirroring order_items (ownership via orders -> stores).
--   C. Backfill: one event per order that already has awb_printed_at, so
--      previously-printed orders are not left with an empty history.
--
-- WHY A SEPARATE TABLE and not an array/jsonb column on `orders`: every print
-- confirm would otherwise be a read-modify-write on the order row, which races
-- with itself when two stores' confirms for one bulk run overlap, and with
-- order sync writing the same row. Append-only inserts cannot lose an entry.
--
-- WHAT DOES NOT CHANGE: orders.awb_printed and orders.awb_printed_at keep
-- their current meaning and are still written on every confirm. The only shift
-- is that awb_printed_at now holds the FIRST print rather than the latest
-- (api/_lib/awbPrinted.js sets it only when null) — the history carries the
-- rest. BulkPrint's "unprinted" filter reads awb_printed, which is unaffected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. The history table.
-- ---------------------------------------------------------------------------
create table if not exists awb_print_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  -- store_id and platform_order_id are denormalised from `orders` on purpose:
  -- they let the server insert an event and the client read a history without
  -- joining, and they keep the event meaningful in an export after the order
  -- row is gone. order_id stays the FK the cascade and the RLS policy use.
  store_id uuid not null references stores (id) on delete cascade,
  platform_order_id text not null,
  printed_at timestamptz not null default now(),
  -- 'single'  — one order printed on its own (Orders page, single tap)
  -- 'bulk'    — part of a multi-order print run (Orders multi-select, BulkPrint)
  -- 'unknown' — backfilled from awb_printed_at by C below, where the mode was
  --             never recorded. Not written by application code.
  print_mode text not null default 'single'
    check (print_mode in ('single', 'bulk', 'unknown')),
  created_at timestamptz not null default now()
);

-- The only read pattern: one order's history, newest first.
create index if not exists idx_awb_print_events_order_printed_at
  on awb_print_events (order_id, printed_at desc);

-- ---------------------------------------------------------------------------
-- B. RLS — mirrors order_items: ownership is reached through orders -> stores.
--
-- select + insert only, deliberately. There is no update or delete policy
-- because the log is append-only: a client that could rewrite or remove an
-- entry would reintroduce exactly the data loss this table exists to fix.
-- The server writes with the service-role key, which bypasses RLS entirely.
-- ---------------------------------------------------------------------------
alter table awb_print_events enable row level security;

drop policy if exists "awb_print_events_select_own" on awb_print_events;
create policy "awb_print_events_select_own" on awb_print_events
  for select using (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = awb_print_events.order_id
        and stores.user_id = auth.uid()
    )
  );

drop policy if exists "awb_print_events_insert_own" on awb_print_events;
create policy "awb_print_events_insert_own" on awb_print_events
  for insert with check (
    exists (
      select 1 from orders
      join stores on stores.id = orders.store_id
      where orders.id = awb_print_events.order_id
        and stores.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- C. Backfill one event per already-printed order.
--
-- Guarded by `not exists` rather than `on conflict` so a re-run cannot add a
-- second copy. There is no unique constraint to conflict on, by design: an
-- order is meant to accumulate many events, so the guard has to be a
-- predicate — "this order has no history yet" — not a constraint.
-- ---------------------------------------------------------------------------
insert into awb_print_events (order_id, store_id, platform_order_id, printed_at, print_mode)
select o.id, o.store_id, o.platform_order_id, o.awb_printed_at, 'unknown'
from orders o
where o.awb_printed_at is not null
  and not exists (
    select 1 from awb_print_events e where e.order_id = o.id
  );

-- ---------------------------------------------------------------------------
-- Verify. Expected: backfilled = the number of orders with awb_printed_at set,
-- orphans = 0, and modes listing only 'unknown' until the first print after
-- deploy.
-- ---------------------------------------------------------------------------
select
  (select count(*) from awb_print_events) as events,
  (select count(*) from orders where awb_printed_at is not null) as printed_orders,
  (select count(*) from orders o
     where o.awb_printed_at is not null
       and not exists (select 1 from awb_print_events e where e.order_id = o.id)
  ) as orphans;

select print_mode, count(*) from awb_print_events group by print_mode order by print_mode;

-- Make awb_print_events queryable immediately rather than after PostgREST's
-- schema cache reloads on its own. Without this the client's select 404s for
-- a while even though the table exists, and the detail sheet silently falls
-- back to the single awb_printed_at date.
notify pgrst, 'reload schema';
