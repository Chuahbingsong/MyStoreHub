-- ============================================================================
-- Website ('website' platform — catsplaytoy.com) migration.
-- Run ONCE in the Supabase SQL editor, against the NEW project (the one Vercel
-- production points at). Idempotent: safe to re-run.
--
-- RUN THIS BEFORE DEPLOYING THE WEBHOOK CODE. api/website.js cannot write a
-- single order without A (the owning `stores` row) and cannot dedupe a retried
-- delivery without B, and both daily_sales() and the Dashboard tiles report
-- website orders WRONG until D and E are in place.
--
-- WHAT THIS DOES
--   A. The one `stores` row every website order hangs off.
--   B. website_webhook_events — delivery-level idempotency for the webhook.
--   C. orders.website_event_sent_at — the out-of-order-delivery guard.
--   D. daily_sales()           + a 'website' branch.
--   E. actionable_order_rows() + a 'website' branch.
--
-- WHY D/E ARE FULL FUNCTION REWRITES: Postgres has no "add a clause to an
-- existing function". Both bodies below are the current definitions from
-- supabase/sales_reporting_migration.sql and
-- supabase/actionable_orders_migration.sql with ONE predicate added each; the
-- added lines are marked `-- WEBSITE:`.
--
-- THREE COPIES OF EACH FUNCTION EXIST IN THIS DIRECTORY, and all three have
-- been updated together with this change:
--   daily_sales()           — here, sales_reporting_migration.sql,
--                             new_project_migration.sql
--   actionable_order_rows() — here, actionable_orders_migration.sql,
--                             new_project_migration.sql
-- They were verified identical (ignoring comments and blank lines) after the
-- edit. This matters because `create or replace function` is last-writer-wins:
-- re-running an older copy that lacked the website branch would silently take
-- website revenue back to zero with nothing failing. If you change the rule,
-- change it in all three.
--
-- THE WEBSITE'S STATUS VOCABULARY (api/website.js writes it VERBATIM into
-- orders.order_status, exactly as every other sync does — the single
-- translation into the app's canonical labels lives in WEBSITE_STATUS_MAP in
-- src/lib/orderStatus.js and nowhere else):
--   'paid'      — payment captured, needs packing  (canonical 'To Pack')
--   'shipped'   — handed to the courier            (canonical 'Shipped')
--   'cancelled' — dead, no money kept              (canonical 'Cancelled')
--   'refunded'  — money returned to the buyer
-- There is deliberately NO unpaid status: catsplaytoy.com only fires
-- order.paid once payment has actually been captured, so an unpaid website
-- order never reaches this database at all. That is why E adds nothing to the
-- non-COD-UNPAID carve-out — see the note there.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- A. The `stores` row for catsplaytoy.com.
--
-- orders.store_id is a FK to stores(id), and EVERY row-level security policy
-- on orders/order_items scopes through stores.user_id = auth.uid(). Without
-- this row the webhook has no store_id to write and, even if it invented one,
-- the seller's own session could not read the orders back. It is the first
-- thing in this file for that reason.
--
-- Single-seller by design: resolved from the one account's email rather than
-- taking a user_id parameter, because there is exactly one seller and a
-- hardcoded uuid in a checked-in migration is worse than a hardcoded email.
--
-- platform 'website' / shop_id 'catsplaytoy.com' are the values api/website.js
-- looks this row up by, and `platform = 'website'` is what D/E and every
-- per-platform display map in src/ key off. Changing either means changing
-- both sides.
--
-- Unlike Shopee/TikTok/Lazada there are no tokens and no OAuth round trip:
-- authentication is the shared HMAC secret on each webhook delivery, so
-- access_token/refresh_token stay NULL and there is no sibling credentials
-- table (no website_shops to match tiktok_shops / lazada_shops).
--
-- is_active true is harmless here — the cron's store queries are filtered to
-- platform = 'shopee', so nothing in api/cron/sync-all.js will ever pick this
-- row up and try to poll an API that does not exist. Website orders arrive by
-- webhook only.
-- ---------------------------------------------------------------------------
insert into stores (user_id, platform, shop_id, shop_name, is_active)
select u.id, 'website', 'catsplaytoy.com', 'catsplaytoy.com', true
from auth.users u
where u.email = 'chuahbingsong@gmail.com'
on conflict (user_id, platform, shop_id) do nothing;

-- Fails the whole script rather than letting the webhook 500 on every delivery
-- later with a far less obvious message. The most likely cause is the email
-- above not matching the account in THIS Supabase project — remember local
-- .env.local points at the OLD project while Vercel production uses the NEW
-- one, and the two have different auth.users rows.
do $$
begin
  if not exists (select 1 from stores where platform = 'website' and shop_id = 'catsplaytoy.com') then
    raise exception 'No stores row was created for catsplaytoy.com — is chuahbingsong@gmail.com a user in THIS Supabase project?';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- B. website_webhook_events — idempotency, keyed on the DELIVERY.
--
-- catsplaytoy.com retries any non-2xx response reusing the SAME X-Delivery-Id,
-- so the delivery id is the one thing that distinguishes "this is the same
-- attempt again" from "this is genuinely new information". api/website.js
-- inserts here FIRST, before touching orders:
--     insert ... on conflict (delivery_id) do nothing ... returning id
-- and a zero-row result means "already processed" -> respond 200 and do
-- nothing else. That is what makes a retry storm cost one cheap insert
-- attempt instead of a duplicate order write and a duplicate push.
--
-- KEYED ON delivery_id, NOT (order_no, status) — this was changed deliberately
-- and must not be "simplified" back. An order legitimately produces several
-- deliveries carrying the SAME status: an order.shipped whose tracking_no was
-- entered wrong and corrected arrives twice as status 'shipped', and the
-- second one MUST apply. Deduping on (order_no, status) would silently drop
-- the correction and leave a wrong tracking number on the order forever.
--
-- The other columns are for debugging a delivery after the fact (which order,
-- which event, how long between the sender's clock and ours) and are not read
-- by any application logic.
--
-- No FK to orders: a delivery for an order_no we have never seen is exactly
-- the case this table has to be able to record, and the insert happens before
-- the order row exists.
-- ---------------------------------------------------------------------------
create table if not exists website_webhook_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  event text,
  order_no text,
  status text,
  -- The sender's own send timestamp from the payload body (sent_at), kept as
  -- they sent it; ours is received_at.
  sent_at timestamptz,
  received_at timestamptz not null default now()
);

create index if not exists idx_website_webhook_events_order_no
  on website_webhook_events (order_no);

-- Retention: this table only ever grows, one row per delivery. At catsplaytoy
-- volumes that is negligible, and it is append-only on purpose — do not prune
-- rows younger than the sender's retry horizon, or a late retry would be
-- reprocessed as new.

-- RLS ON WITH NO POLICIES = deny-all to `authenticated`, full access to the
-- service-role key. That is exactly right here: api/website.js uses the
-- service-role client (api/_lib/supabaseAdmin.js) and no browser code reads
-- this table.
--
-- This table is deliberately NOT added to the C1/C2 table-name arrays in
-- supabase/new_project_migration.sql PART C, and that is the safe choice in
-- both directions: those loops would be enabling RLS on a table that file
-- never creates (so a run against a fresh project would error), and leaving it
-- out means a re-run of that file simply does not touch this table — which
-- leaves it exactly as this line sets it. Deny-all survives either way.
alter table website_webhook_events enable row level security;


-- ---------------------------------------------------------------------------
-- C. orders.website_event_sent_at — the out-of-order-delivery guard.
--
-- B stops the same delivery being applied twice. It does NOT stop two
-- DIFFERENT deliveries being applied in the wrong order, which is a real
-- failure mode with at-least-once delivery plus retries:
--
--     order.paid    (delivery 1, sent 08:14) -> network failure, retried later
--     order.shipped (delivery 2, sent 09:30) -> arrives first, applied
--     order.paid    (delivery 1, retry)      -> arrives second, applied
--                                               => order is back to 'paid',
--                                                  tracking_no wiped
--
-- Both deliveries are new to B (different delivery_ids) and both are
-- individually legitimate, so only the payload's own send time can order them.
-- api/website.js stamps this column with the payload's sent_at on every
-- applied delivery and skips any delivery whose sent_at is OLDER than what is
-- already stored — a stale replay becomes a no-op 200 rather than a status
-- regression. (The delivery is still recorded in B either way.)
--
-- Nullable with no default: existing rows, and every non-website order, are
-- NULL, and NULL compares as "nothing applied yet", so the first delivery for
-- an order always wins.
-- ---------------------------------------------------------------------------
alter table orders add column if not exists website_event_sent_at timestamptz;


-- ---------------------------------------------------------------------------
-- D. daily_sales(p_days) — + the 'website' revenue branch.
--
-- Body is the current definition from supabase/sales_reporting_migration.sql;
-- the ONLY change is the `-- WEBSITE:` clause in `scoped`. Every comment in
-- that file about timezone handling, the order-placement date field and why
-- this is a function rather than a client-side sum still applies and is not
-- repeated here.
--
-- WITHOUT this branch website revenue would be ALWAYS ZERO, silently, while
-- the order count beside it on the Dashboard counted website orders fine —
-- the precise bug that hid every Lazada sale (see the long note in
-- sales_reporting_migration.sql, which ends by telling you to come and do
-- this when a new platform is connected).
--
-- COUNTED: 'paid', 'shipped'.  NOT counted: 'cancelled', 'refunded'.
--
-- 'paid' BREAKS THE "paid AND at least packed" RULE THE OTHER PLATFORMS
-- FOLLOW, on purpose. Shopee's READY_TO_SHIP and Lazada's 'pending' are
-- canonical 'To Pack' and are excluded there because a marketplace order can
-- sit in that state having never actually been paid (cash at counter, COD).
-- A website 'paid' order has had its money CAPTURED through our own checkout
-- before the webhook ever fires — there is no unpaid website order in this
-- database at all (see the vocabulary note at the top). So for this platform
-- 'To Pack' and "money received" are the same event, and excluding it would
-- hide today's real takings until each parcel was packed.
--
-- The consequence to expect, stated plainly: a website sale appears in the
-- report the moment it is paid, whereas a Shopee sale of the same minute does
-- not appear until it is packed. That asymmetry is in the DATA, not a bug.
--
-- 'refunded' is excluded alongside 'cancelled' because both mean no money
-- kept, which is the same reason cancellations have never been counted here.
-- ---------------------------------------------------------------------------
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
        -- Shopee v2 order_status (SHOPEE_STATUS_MAP in src/lib/orderStatus.js)
        (o.platform = 'shopee' and o.order_status in (
          'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'
        ))
        -- Lazada, lowercase and collapsed least-progressed-wins before it is
        -- written (LAZADA_STATUS_MAP / api/_lib/lazadaSync.js). 'confirmed'
        -- counts because it means settled-but-no-fulfilment-detail. 'pending'
        -- is Lazada's To Pack and is excluded.
        or (o.platform = 'lazada' and o.order_status in (
          'packed', 'ready_to_ship', 'shipped', 'delivered', 'confirmed'
        ))
        -- TikTok Shop v202309 (TIKTOK_STATUS_MAP). That map is documented-but-
        -- unverified against live data, so this list inherits the same caveat.
        or (o.platform = 'tiktok' and o.order_status in (
          'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'
        ))
        -- WEBSITE: catsplaytoy.com (WEBSITE_STATUS_MAP). 'paid' IS counted
        -- here unlike every other platform's To Pack equivalent — read the
        -- long note above before "fixing" it.
        or (o.platform = 'website' and o.order_status in (
          'paid', 'shipped'
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


-- ---------------------------------------------------------------------------
-- E. actionable_order_rows(p_days) — + the 'website' exclusions.
--
-- Body is the current definition from
-- supabase/actionable_orders_migration.sql; the ONLY change is the
-- `-- WEBSITE:` clause in exclusion (1). THE RULE still lives in exactly one
-- place — this function — and both readers follow it unchanged:
-- todays_actionable_orders() (Dashboard tiles) and actionable_orders_for_day()
-- (Revenue breakdown). Neither is redefined here: the return shape is
-- untouched, so they keep working against the new body.
--
-- (1) CANCELLED-equivalent, never counted: website 'cancelled' AND 'refunded'.
--
--     ASYMMETRY, FLAGGED DELIBERATELY: for the marketplaces this exclusion
--     covers ONLY canonical Cancelled — canonical Returned and Return
--     Requested stay INCLUDED, which that file calls out as "only CANCELLED
--     was asked for ... until told otherwise". Website 'refunded' is excluded
--     anyway because, unlike a marketplace return-in-progress, it is terminal
--     and unambiguous: the money is already back with the buyer, so there is
--     nothing actionable and nothing kept. Keeping it would also contradict D
--     above, which does not count it as revenue. To reverse this, delete
--     'refunded' from the one list below — nothing else depends on it.
--
-- (2) The non-COD-UNPAID carve-out gets NOTHING for website, and that is not
--     an omission. The carve-out exists to drop marketplace orders that were
--     never paid and mostly never will be; catsplaytoy.com does not emit an
--     unpaid status at all, so there is no website row it could ever match.
--     Adding a branch there would be dead SQL implying a state that cannot
--     exist. If the site ever starts sending unpaid/pending orders, that is
--     the line to revisit — along with D.
-- ---------------------------------------------------------------------------
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
      -- WEBSITE: both terminal no-money-kept states — see the note above.
      or (o.platform = 'website' and o.order_status in ('cancelled', 'refunded'))
    )
    -- (2) Among what's left, exclude UNPAID orders that aren't COD.
    -- Everything else — including UNPAID + COD — counts. No website branch
    -- here on purpose: see (2) in the note above.
    and not (
      (
        (o.platform = 'shopee' and o.order_status = 'UNPAID')
        or (o.platform = 'tiktok' and o.order_status in ('UNPAID', 'ON_HOLD'))
        or (o.platform = 'lazada' and o.order_status = 'unpaid')
      )
      and lower(trim(o.payment_method)) not in ('cash on delivery', 'cod')
    );
$$;


grant execute on function daily_sales(int) to authenticated;
grant execute on function actionable_order_rows(int) to authenticated;

-- PostgREST answers RPC calls from a cached view of the schema. Supabase
-- reloads it on its own, but not always instantly — this makes the rewritten
-- functions callable the moment this script finishes rather than after an
-- unpredictable wait ("Could not find the function public.daily_sales(p_days)
-- in the schema cache" is what the wait looks like).
notify pgrst, 'reload schema';
