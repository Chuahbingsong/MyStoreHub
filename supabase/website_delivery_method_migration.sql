-- ============================================================================
-- Website delivery method (catsplaytoy.com instant delivery).
-- Run ONCE in the Supabase SQL editor, against the NEW project (the one Vercel
-- production points at). Idempotent: safe to re-run.
--
-- RUN THIS BEFORE DEPLOYING THE CODE THAT WRITES THESE COLUMNS. The webhook
-- upsert in api/_lib/websiteOrders.js includes them whenever the payload does,
-- and an upsert naming a column that does not exist fails — every delivery
-- would 500 and the sender would retry it.
--
--   orders.delivery_method   'standard' | 'instant' (stored verbatim; any other
--                            value is kept as-is and the UI treats it as normal)
--   orders.instant_delivery  the payload's instant_delivery object, verbatim:
--                            { awaiting_arrangement, courier, booked_by,
--                              delivery_fee_cents, fee_payment, tracking_url,
--                              arranged_at }. NULL for standard orders.
--
-- Both nullable with no default, so existing rows and every non-website order
-- stay NULL.
-- ============================================================================

alter table orders add column if not exists delivery_method text;
alter table orders add column if not exists instant_delivery jsonb;

notify pgrst, 'reload schema';
