-- MyStore Hub — per-store shipping method preference for Shopee auto-pack
-- Paste into the Supabase SQL Editor. Safe to re-run.
--
-- Some orders offer BOTH pickup and dropoff in info_needed (confirmed against
-- live data). Until now selectShippingMethod() (api/_lib/shopeeShip.js) always
-- picked pickup first, so dropoff was never reachable for those orders even
-- when a store's courier setup makes dropoff the better default. This column
-- lets a seller opt a store into preferring one method when the order's
-- info_needed actually offers it; when it doesn't, or the preference is null,
-- behavior falls back to today's pickup -> dropoff -> non_integrated priority.
--
-- non_integrated is intentionally not an allowed value: it always requires
-- seller-supplied tracking info regardless of preference, so there is nothing
-- to "prefer" about it.

alter table stores add column if not exists preferred_shipping_method text;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guarded DO block.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_preferred_shipping_method_check'
  ) then
    alter table stores add constraint stores_preferred_shipping_method_check
      check (preferred_shipping_method in ('pickup', 'dropoff'));
  end if;
end $$;
