-- MyStore Hub — persist the actual shipping method Shopee's ship_order used
-- Paste into the Supabase SQL Editor. Safe to re-run.
--
-- Until now, the pickup/dropoff/non_integrated decision made in
-- selectShippingMethod() (api/_lib/shopeeShip.js) only ever reached
-- console.log — Vercel's ephemeral stdout, gone once log retention rolls
-- off. Neither `orders` nor `sync_logs` recorded it, so "which method fired
-- on this order" was unanswerable after the fact for both auto-pack and the
-- manual Pack button. This column plus the sync_logs message change in
-- api/_lib/shopeeShip.js, api/_lib/autoPack.js, and api/shopee/order-action.js
-- make it queryable going forward.

alter table orders add column if not exists shipping_method text;
