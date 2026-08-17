import crypto from 'crypto';
import {
  LAZADA_APP_KEY,
  LAZADA_REDIRECT_URI,
  LAZADA_AUTH_HOST,
  LAZADA_TOKEN_CREATE_PATH,
  generateSign,
} from './_lib/lazada.js';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { withCors } from './_lib/cors.js';
import { syncLazadaShopOrders, getLazadaStoresToSync, SYNC_TIME_BUDGET_MS } from './_lib/lazadaSync.js';

// Combines what would otherwise be api/lazada/auth.js and
// api/lazada/callback.js into one Vercel function (dispatched on ?action=),
// same reasoning as api/tiktok.js: stay under the Hobby plan's 12-function
// cap (underscore-prefixed files under api/_lib/ don't count against it).
// ?action=sync exposes lazadaSync.js's order sync the same way api/tiktok.js
// does — the sync logic itself lives in _lib, this function only dispatches.
export const config = { maxDuration: 60 };

export default withCors(handler);

function handler(req, res) {
  const { action } = req.query;

  if (action === 'auth') return handleAuth(req, res);
  if (action === 'callback') return handleCallback(req, res);
  if (action === 'sync') return handleSync(req, res);

  return res
    .status(400)
    .json({ error: 'Unknown or missing action. Use ?action=auth, ?action=callback or ?action=sync' });
}

// Same HMAC-over-service-role-key convention as api/tiktok.js's
// signOAuthUser: lets ?action=callback trust a user id that arrived via an
// ordinary, unsigned browser cookie, since a client can edit their own
// cookie jar freely but can't forge this signature without the service role
// key, which never reaches the browser.
function signOAuthUser(userId, state) {
  return crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '')
    .update(`${userId}:${state}`)
    .digest('hex');
}

async function handleAuth(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Same Bearer-token session verification every other authenticated
  // endpoint in this app uses (see api/tiktok.js) — only possible because the
  // caller reaches this via fetch(), not a raw top-level navigation, which is
  // also why this returns JSON ({ authUrl }) instead of a 302.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error('[lazada/auth] session verification failed', authError);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const userSig = signOAuthUser(user.id, state);

  // Two httpOnly cookies, both 10-minute-lived (long enough for the Lazada
  // consent screen, no longer): lazada_oauth_state is the CSRF nonce;
  // lazada_oauth_user carries the VERIFIED user id through the redirect to
  // Lazada and back, since that round trip can't carry an Authorization
  // header the way this request could.
  res.setHeader('Set-Cookie', [
    `lazada_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `lazada_oauth_user=${user.id}:${userSig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);

  const authUrl =
    `${LAZADA_AUTH_HOST}/oauth/authorize?response_type=code&force_auth=true` +
    `&client_id=${encodeURIComponent(LAZADA_APP_KEY)}` +
    `&redirect_uri=${encodeURIComponent(LAZADA_REDIRECT_URI)}` +
    `&state=${state}`;

  console.log('[lazada/auth] constructed authUrl:', authUrl);

  // JSON, not a redirect — see api/tiktok.js's handleAuth for why: verifying
  // the session above needs a fetch() call with an Authorization header,
  // which a top-level navigation can't send.
  return res.status(200).json({ authUrl });
}

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleCallback(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state } = req.query;

  const cookieState = parseCookie(req.headers.cookie, 'lazada_oauth_state');
  const stateOk = Boolean(state) && Boolean(cookieState) && state === cookieState;

  // Only trust the user cookie once the CSRF state itself checks out — the
  // signature is verified against THIS state value, so there's nothing to
  // gain by checking it earlier. Both checks (state, then session) must pass
  // before anything else runs — failing closed, same as api/tiktok.js.
  let userId = null;
  if (stateOk) {
    const cookieUser = parseCookie(req.headers.cookie, 'lazada_oauth_user');
    if (cookieUser) {
      const separatorIndex = cookieUser.indexOf(':');
      const candidateUserId = separatorIndex === -1 ? null : cookieUser.slice(0, separatorIndex);
      const candidateSig = separatorIndex === -1 ? null : cookieUser.slice(separatorIndex + 1);
      if (candidateUserId && candidateSig && signOAuthUser(candidateUserId, state) === candidateSig) {
        userId = candidateUserId;
      }
    }
  }
  const sessionOk = Boolean(userId);

  const result = {
    stateOk,
    sessionOk,
    tokenExchange: { ok: false, raw: null },
    dbUpsert: { ok: false, raw: null },
    storeMirror: { ok: false, raw: null },
    seller_id: null,
    shop_name: null,
    country: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    store_id: null,
  };

  if (!code) {
    return res.status(200).send(renderDebugPage(result, 'Missing code in query string'));
  }

  if (!stateOk) {
    console.log('[lazada/callback] state mismatch', { received: state, expected: cookieState });
    return res.status(200).send(renderDebugPage(result, 'CSRF state mismatch — aborting before token exchange'));
  }

  if (!sessionOk) {
    console.log('[lazada/callback] missing or invalid session cookie — aborting before token exchange');
    return res
      .status(200)
      .send(renderDebugPage(result, 'Missing or invalid session — reconnect from Settings while logged in'));
  }

  // 1. Exchange the auth code for tokens. Lazada requires every call —
  // including this one, before any access_token exists — to be signed.
  let accessToken;
  let refreshToken;
  let expiresIn;
  let refreshExpiresIn;
  let sellerId;
  let shopName;
  let country;
  try {
    const timestamp = String(Date.now());
    const params = {
      app_key: LAZADA_APP_KEY,
      code,
      sign_method: 'sha256',
      timestamp,
    };
    const sign = generateSign(LAZADA_TOKEN_CREATE_PATH, params);

    const tokenUrl = `${LAZADA_AUTH_HOST}/rest${LAZADA_TOKEN_CREATE_PATH}?${new URLSearchParams({ ...params, sign }).toString()}`;

    const tokenResponse = await fetch(tokenUrl, { method: 'POST' });
    const tokenBody = await tokenResponse.json();
    console.log('[lazada/callback] auth/token/create raw response:', JSON.stringify(tokenBody));

    result.tokenExchange.raw = tokenBody;

    // Lazada returns errors inside HTTP 200s, so the body's own `code` field
    // is the real signal — not tokenResponse.ok. Success responses either
    // omit `code` entirely or carry "0"; anything else (or a missing
    // access_token) is a failure.
    if (!tokenResponse.ok || !tokenBody.access_token || (tokenBody.code && tokenBody.code !== '0')) {
      return res.status(200).send(renderDebugPage(result, 'Token exchange failed'));
    }

    accessToken = tokenBody.access_token;
    refreshToken = tokenBody.refresh_token;
    expiresIn = tokenBody.expires_in;
    refreshExpiresIn = tokenBody.refresh_expires_in;

    const countryUserInfo = (tokenBody.country_user_info && tokenBody.country_user_info[0]) || {};
    sellerId = countryUserInfo.seller_id ?? tokenBody.seller_id;
    country = countryUserInfo.country ?? tokenBody.country;
    shopName = tokenBody.account ?? countryUserInfo.short_code ?? null;

    console.log(
      '[lazada/callback] raw duration values — expires_in:',
      expiresIn,
      'refresh_expires_in:',
      refreshExpiresIn
    );

    result.tokenExchange.ok = true;
    result.seller_id = sellerId;
    result.shop_name = shopName;
    result.country = country;

    if (!sellerId) {
      return res.status(200).send(renderDebugPage(result, 'Token response missing seller_id'));
    }
  } catch (err) {
    console.log('[lazada/callback] auth/token/create threw:', err);
    result.tokenExchange.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Token exchange request threw an exception'));
  }

  // Lazada's expires_in/refresh_expires_in are DURATIONS in seconds (the
  // opposite of TikTok's token/get, which returns absolute Unix timestamps
  // despite the same `_expire_in`-shaped naming) — so expiry is computed as
  // Date.now() + value * 1000, never `new Date(value * 1000)`.
  result.accessTokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  result.refreshTokenExpiresAt = refreshExpiresIn
    ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
    : null;

  // Sanity check: a correctly-interpreted access token expiry should land
  // roughly 7 days out, and the refresh token roughly 30 days out. Outside
  // that band means Lazada's response shape changed (e.g. switched to
  // absolute timestamps, TikTok-style).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const accessExpiryMs = expiresIn * 1000;
  if (accessExpiryMs < 6 * DAY_MS || accessExpiryMs > 8 * DAY_MS) {
    console.warn(
      '[lazada/callback] access token expires_in outside expected ~7 day range — raw expires_in:',
      expiresIn,
      'resolved to:',
      result.accessTokenExpiresAt
    );
  }
  if (refreshExpiresIn != null) {
    const refreshExpiryMs = refreshExpiresIn * 1000;
    if (refreshExpiryMs < 28 * DAY_MS || refreshExpiryMs > 32 * DAY_MS) {
      console.warn(
        '[lazada/callback] refresh_expires_in outside expected ~30 day range — raw refresh_expires_in:',
        refreshExpiresIn,
        'resolved to:',
        result.refreshTokenExpiresAt
      );
    }
  }

  // 2. Persist credentials. lazada_shops is the sole source of truth for
  // Lazada tokens — the stores mirror below never gets access_token/
  // refresh_token written to it. Upsert keyed on (seller_id, country), the
  // table's real unique constraint.
  try {
    const { error: dbError } = await supabaseAdmin.from('lazada_shops').upsert(
      {
        seller_id: String(sellerId),
        shop_name: shopName,
        country: country || 'MY',
        access_token: accessToken,
        refresh_token: refreshToken,
        access_token_expires_at: result.accessTokenExpiresAt,
        refresh_token_expires_at: result.refreshTokenExpiresAt,
        user_id: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'seller_id,country' }
    );

    if (dbError) {
      console.log('[lazada/callback] supabase upsert error:', JSON.stringify(dbError));
      result.dbUpsert.raw = dbError;
      return res.status(200).send(renderDebugPage(result, 'Supabase upsert failed'));
    }

    result.dbUpsert.ok = true;
  } catch (err) {
    console.log('[lazada/callback] supabase upsert threw:', err);
    result.dbUpsert.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Supabase upsert threw an exception'));
  }

  // 3. Mirror into `stores` — identity/ownership only, never credentials — so
  // orders/sync_logs (FK'd to stores(id)) and the per-store ownership checks
  // every endpoint already does against `stores.user_id` work for a Lazada
  // shop with no code changes elsewhere. Then link lazada_shops back to the
  // mirror row via store_id.
  try {
    const { data: storeRow, error: storeError } = await supabaseAdmin
      .from('stores')
      .upsert(
        {
          user_id: userId,
          platform: 'lazada',
          shop_id: String(sellerId),
          shop_name: shopName,
          is_active: true,
        },
        { onConflict: 'user_id,platform,shop_id' }
      )
      .select('id')
      .single();

    if (storeError) {
      console.log('[lazada/callback] stores mirror upsert error:', JSON.stringify(storeError));
      result.storeMirror.raw = storeError;
      return res.status(200).send(renderDebugPage(result, 'Stores mirror upsert failed'));
    }

    result.store_id = storeRow.id;

    const { error: linkError } = await supabaseAdmin
      .from('lazada_shops')
      .update({ store_id: storeRow.id })
      .eq('seller_id', String(sellerId))
      .eq('country', country || 'MY');

    if (linkError) {
      console.log('[lazada/callback] lazada_shops.store_id link error:', JSON.stringify(linkError));
      result.storeMirror.raw = linkError;
      return res.status(200).send(renderDebugPage(result, 'Failed to link lazada_shops.store_id'));
    }

    result.storeMirror.ok = true;
  } catch (err) {
    console.log('[lazada/callback] stores mirror threw:', err);
    result.storeMirror.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Stores mirror threw an exception'));
  }

  return res.status(200).send(renderDebugPage(result, null));
}

function renderDebugPage(result, fatalError) {
  const rows = [
    ['CSRF state check', result.stateOk],
    ['Session verified', result.sessionOk],
    ['Token exchange succeeded', result.tokenExchange.ok],
    ['lazada_shops upsert succeeded', result.dbUpsert.ok],
    ['stores mirror written', result.storeMirror.ok],
  ];

  const failedRaw = [
    ['tokenExchange', result.tokenExchange],
    ['dbUpsert', result.dbUpsert],
    ['storeMirror', result.storeMirror],
  ].filter(([, step]) => !step.ok && step.raw != null);

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Lazada Open Platform OAuth Debug</title>
<style>
  body { font-family: monospace; padding: 24px; background: #111; color: #eee; }
  table { border-collapse: collapse; margin-bottom: 24px; }
  td, th { border: 1px solid #444; padding: 6px 12px; text-align: left; }
  .ok { color: #4caf50; }
  .fail { color: #f44336; }
  pre { background: #1c1c1c; padding: 12px; overflow-x: auto; border: 1px solid #444; }
  h2 { margin-top: 32px; }
</style>
</head>
<body>
<h1>Lazada Open Platform OAuth — Debug</h1>
${fatalError ? `<p class="fail"><strong>${esc(fatalError)}</strong></p>` : '<p class="ok"><strong>All steps completed successfully.</strong></p>'}
<table>
<tr><th>Step</th><th>Status</th></tr>
${rows.map(([label, ok]) => `<tr><td>${esc(label)}</td><td class="${ok ? 'ok' : 'fail'}">${ok ? 'OK' : 'FAILED'}</td></tr>`).join('\n')}
</table>
<table>
<tr><th>Field</th><th>Value</th></tr>
<tr><td>seller_id</td><td>${esc(result.seller_id)}</td></tr>
<tr><td>shop_name</td><td>${esc(result.shop_name)}</td></tr>
<tr><td>country</td><td>${esc(result.country)}</td></tr>
<tr><td>access_token_expires_at</td><td>${esc(result.accessTokenExpiresAt)}</td></tr>
<tr><td>refresh_token_expires_at</td><td>${esc(result.refreshTokenExpiresAt)}</td></tr>
<tr><td>stores.id (mirror row)</td><td>${esc(result.store_id)}</td></tr>
</table>
${failedRaw.map(([name, step]) => `<h2>Raw response — ${esc(name)}</h2><pre>${esc(JSON.stringify(step.raw, null, 2))}</pre>`).join('\n')}
</body>
</html>`;
}

// Same shape as api/tiktok.js's handleSync: POST + Bearer session, optional
// store_id scoped to this user, one deadline shared across every store synced
// in the request so N stores still respect one 60s wall.
async function handleSync(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error('[lazada/sync] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, days: daysRaw } = req.body ?? {};
  const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0 ? Number(daysRaw) : undefined;

  if (store_id) {
    const { data: requestedStore, error: storeLookupError } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .eq('platform', 'lazada')
      .maybeSingle();

    if (storeLookupError) {
      console.error('[lazada/sync] failed to load store', storeLookupError);
      return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
    }
    if (!requestedStore) {
      return res.status(404).json({ success: false, error: 'No matching Lazada store found' });
    }
    if (requestedStore.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
  }

  const { data: stores, error: storesError } = await getLazadaStoresToSync({ userId: user.id, storeId: store_id });

  if (storesError) {
    console.error('[lazada/sync] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    return res.status(404).json({ success: false, error: 'No matching Lazada store found' });
  }

  const results = [];
  const errors = [];
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  for (const store of stores) {
    try {
      console.log('[lazada/sync] syncing store', store.id, store.shop_id);
      const result = await syncLazadaShopOrders(store, { days, deadline });
      results.push(result);
    } catch (err) {
      // syncLazadaShopOrders already records this in sync_logs itself (a
      // started-but-uncompleted row if it was killed by a hard timeout, or an
      // explicit 'error' row otherwise) — this catch only needs to keep the
      // per-store loop going and surface the failure in the HTTP response.
      console.error('[lazada/sync] sync failed for store', store.id, err);
      errors.push({ storeId: store.id, error: err.message });
    }
  }

  const allOrders = results.flatMap((r) => r.orders);
  const hasMore = results.some((r) => r.hasMore);

  if (errors.length > 0 && results.length === 0) {
    return res.status(502).json({ success: false, errors });
  }

  return res.status(200).json({
    success: true,
    synced: allOrders.length,
    stores: results.length,
    has_more: hasMore,
    errors,
  });
}
