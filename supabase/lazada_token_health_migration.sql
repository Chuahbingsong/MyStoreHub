-- Lazada token health — run in the NEW project (ebzfmepsyfflxnsvbexl) BEFORE
-- deploying the code that reads these columns. Idempotent.
--
-- Lazada refresh tokens die ~30 days after authorization no matter how often
-- they are refreshed (both shops: connected 2026-08-13, IllegalRefreshToken
-- from 2026-09-13; reconnected 2026-09-18, lapsed 2026-10-18). Without a
-- marker the cron retried the dead token on every 5-minute tick — 992 failed
-- calls in five days. refreshLazadaToken in api/_lib/lazada.js now sets
-- refresh_token_dead_at once (on IllegalRefreshToken, or once
-- refresh_token_expires_at has passed) and never calls Lazada again for that
-- shop; api/lazada.js's callback clears it on reconnect.

alter table public.lazada_shops add column if not exists refresh_token_dead_at timestamptz;
alter table public.lazada_shops add column if not exists refresh_token_dead_reason text;

-- Verify: both rows should come back.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'lazada_shops'
  and column_name in ('refresh_token_dead_at', 'refresh_token_dead_reason');
