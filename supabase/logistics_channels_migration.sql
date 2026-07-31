-- MyStore Hub — shipping method (logistics channel) preferences
-- Paste into the Supabase SQL Editor. Safe to re-run.
--
-- Backs the Shipping page (src/pages/Shipping.jsx), which reads live channel
-- state from Shopee's get_channel_list on every load and never caches it —
-- so there is NO cache table here. Shopee is the single source of truth for
-- `enabled`; caching it would only create a second, staler answer.
--
-- What IS stored is the audit trail. Every toggle attempt writes one row,
-- including the read-back verdict and any collateral changes Shopee made to
-- OTHER channels as a side effect (channel_relation_rules cascades, which
-- are self-contradictory in Shopee's own metadata and therefore cannot be
-- predicted — only observed after the fact by diffing a full re-fetch).
--
-- Toggles are ALSO logged to sync_logs (sync_type = 'logistics_channel')
-- like every other Shopee write in this app. This table exists in addition
-- because sync_logs.message is free text: querying "which channel changed,
-- for which store, and did it actually stick" out of a text blob is painful,
-- and the collateral list needs to be structured to be useful at all.

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

-- ---------------------------------------------------------------------------
-- RLS — same store-ownership pattern as orders/sync_logs in supabase/rls.sql.
-- Writes come from the service role (api/shopee/logistics-channels.js), which
-- bypasses RLS; these policies exist so the browser can READ its own history
-- and so nothing else can.
-- ---------------------------------------------------------------------------
alter table logistics_channel_audit enable row level security;

drop policy if exists "logistics_channel_audit_select_own" on logistics_channel_audit;
create policy "logistics_channel_audit_select_own" on logistics_channel_audit
  for select using (
    exists (
      select 1 from stores
      where stores.id = logistics_channel_audit.store_id
        and stores.user_id = auth.uid()
    )
  );

-- Deliberately no insert/update/delete policy for end users: the audit trail
-- is append-only and written exclusively by the server. A seller must not be
-- able to edit or erase the record of a live-store change.
