import crypto from 'crypto';
import {
  TIKTOK_APP_KEY,
  TIKTOK_APP_SECRET,
  TIKTOK_REDIRECT_URI,
  TIKTOK_AUTH_BASE,
  TIKTOK_API_BASE,
  generateSign,
} from './_lib/tiktok.js';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { withCors } from './_lib/cors.js';
import { syncTikTokShopOrders, getTikTokStoresToSync, SYNC_TIME_BUDGET_MS } from './_lib/tiktokSync.js';
// TEMPORARY — remove with api/_lib/labelProbe.js. See that file's banner.
import { handleTikTokProbe } from './_lib/labelProbe.js';

// Combines what used to be api/tiktok/auth.js and api/tiktok/callback.js into
// one Vercel function (dispatched on ?action=) to stay under the Hobby plan's
// 12-function cap. ?action=auth now also requires an authenticated session
// and carries that user's id through the OAuth round trip (see
// signOAuthUser below) — the ?action=auth response is JSON, not a redirect,
// so the frontend calling it needs to fetch() with an Authorization header
// and then do window.location.href = data.authUrl itself.
// ?action=sync exposes tiktokSync.js's order sync the same way — kept behind
// this existing function rather than a new one (api/shopee/sync.js mirrors
// this same "sync logic lives in _lib, function just dispatches" shape).
export const config = { maxDuration: 60 };

export default withCors(handler);

function handler(req, res) {
  const { action } = req.query;

  if (action === 'auth') return handleAuth(req, res);
  if (action === 'callback') return handleCallback(req, res);
  if (action === 'sync') return handleSync(req, res);
  // TEMPORARY — remove with api/_lib/labelProbe.js. See that file's banner.
  if (action === 'probe') return handleTikTokProbe(req, res);

  return res.status(400).json({ error: 'Unknown or missing action. Use ?action=auth, ?action=callback, ?action=sync or ?action=probe (temporary)' });
}

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
    console.error('[tiktok/sync] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, days: daysRaw } = req.body ?? {};
  const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0 ? Number(daysRaw) : undefined;

  if (store_id) {
    const { data: requestedStore, error: storeLookupError } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .eq('platform', 'tiktok')
      .maybeSingle();

    if (storeLookupError) {
      console.error('[tiktok/sync] failed to load store', storeLookupError);
      return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
    }
    if (!requestedStore) {
      return res.status(404).json({ success: false, error: 'No matching TikTok store found' });
    }
    if (requestedStore.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
  }

  const { data: stores, error: storesError } = await getTikTokStoresToSync({ userId: user.id, storeId: store_id });

  if (storesError) {
    console.error('[tiktok/sync] failed to load stores', storesError);
    return res.status(500).json({ success: false, error: 'Failed to load stores from Supabase' });
  }

  if (!stores || stores.length === 0) {
    return res.status(404).json({ success: false, error: 'No matching TikTok store found' });
  }

  const results = [];
  const errors = [];
  // Shared across every store synced in this request, same convention as
  // api/shopee/sync.js — N stores in one call still respect one 60s wall.
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  for (const store of stores) {
    try {
      console.log('[tiktok/sync] syncing store', store.id, store.shop_id);
      const result = await syncTikTokShopOrders(store, { days, deadline });
      results.push(result);
    } catch (err) {
      // syncTikTokShopOrders already records this in sync_logs itself (a
      // started-but-uncompleted row if it was killed by a hard timeout, or an
      // explicit 'error' row otherwise) — this catch only needs to keep the
      // per-store loop going and surface the failure in the HTTP response.
      console.error('[tiktok/sync] sync failed for store', store.id, err);
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
    hasMore,
    orders: allOrders,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// HMACs a user id together with the CSRF state value using the (already
// process.env-sourced) service role key as the signing secret. This is what
// lets ?action=callback trust a user id that arrived via an ordinary,
// unsigned browser cookie: a client can edit their own cookie jar freely,
// but can't produce a signature without the service role key, which never
// reaches the browser. Binding the state value into the signature also means
// a captured cookie can't be replayed against a different auth attempt.
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

  // api/shopee/oauth.js's ?action=auth has no session check at all (it
  // hardcodes a single user_id downstream) — there's no existing mechanism to
  // mirror for "require an authenticated session". This instead reuses the
  // Bearer-token verification convention every OTHER authenticated endpoint
  // in this app already uses (see api/shopee/sync.js), which is only
  // possible because the caller reaches this via fetch(), not a raw
  // top-level navigation — see the JSON response note below.
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
    console.error('[tiktok/auth] session verification failed', authError);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const userSig = signOAuthUser(user.id, state);

  // Two httpOnly cookies, both 10-minute-lived (long enough for the TikTok
  // consent screen, no longer): tiktok_oauth_state is the existing CSRF
  // nonce; tiktok_oauth_user carries the VERIFIED user id through the
  // redirect to TikTok and back, since that round trip can't carry an
  // Authorization header the way this request could.
  res.setHeader('Set-Cookie', [
    `tiktok_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `tiktok_oauth_user=${user.id}:${userSig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);

  const authUrl =
    `${TIKTOK_AUTH_BASE}/api/v2/authorization?app_key=${encodeURIComponent(TIKTOK_APP_KEY)}` +
    `&state=${state}&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}`;

  // JSON, not a redirect — mirrors api/shopee/oauth.js's ?action=auth shape
  // ({ authUrl }, with the frontend doing window.location.href itself).
  // Required here (this previously did a raw 302) because verifying the
  // session above needs a fetch() call with an Authorization header, which a
  // top-level navigation can't send.
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

// Prefers whatever shop-type/environment signal the authorized-shops response
// itself carries — checked across a few plausibly-named fields since TikTok's
// exact field name for this isn't confirmed against a live response (same
// defensive ?? chaining as shop.id/shop.name/shop.cipher above). Falls back to
// the documented SANDBOX_ name prefix only when none of those fields say
// anything sandbox-shaped. Returns which field decided it, so the raw log
// line below makes the detection method verifiable rather than a black box.
function detectIsSandbox(shop, shopName) {
  const candidateFields = ['seller_type', 'shop_type', 'type', 'code'];

  for (const field of candidateFields) {
    const value = shop[field];
    if (typeof value === 'string' && value.toUpperCase().includes('SANDBOX')) {
      return { isSandbox: true, source: `shop.${field}="${value}"` };
    }
  }

  const isSandboxByName = typeof shopName === 'string' && shopName.toUpperCase().startsWith('SANDBOX_');
  return {
    isSandbox: isSandboxByName,
    source: isSandboxByName
      ? `shop.name prefix ("${shopName}" starts with SANDBOX_)`
      : `no sandbox signal found (checked ${candidateFields.map((f) => `shop.${f}`).join(', ')}, and name prefix)`,
  };
}

async function handleCallback(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, auth_code, state } = req.query;
  const authCode = code || auth_code;

  const cookieState = parseCookie(req.headers.cookie, 'tiktok_oauth_state');
  const stateOk = Boolean(state) && Boolean(cookieState) && state === cookieState;

  // Only trust the user cookie once the CSRF state itself checks out — the
  // signature is verified against THIS state value, so there's nothing to
  // gain by checking it earlier.
  let userId = null;
  if (stateOk) {
    const cookieUser = parseCookie(req.headers.cookie, 'tiktok_oauth_user');
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
    authorizedShops: { ok: false, raw: null },
    dbUpsert: { ok: false, raw: null },
    storeMirror: { ok: false, raw: null },
    shop_id: null,
    shop_name: null,
    hasShopCipher: false,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    store_id: null,
    isSandbox: null,
    sandboxSource: null,
  };

  if (!authCode) {
    return res.status(200).send(renderDebugPage(result, 'Missing code/auth_code in query string'));
  }

  if (!stateOk) {
    console.log('[tiktok/callback] state mismatch', { received: state, expected: cookieState });
    return res.status(200).send(renderDebugPage(result, 'CSRF state mismatch — aborting before token exchange'));
  }

  if (!sessionOk) {
    console.log('[tiktok/callback] missing or invalid session cookie — aborting before token exchange');
    return res
      .status(200)
      .send(renderDebugPage(result, 'Missing or invalid session — reconnect from Settings while logged in'));
  }

  // 1. Exchange the auth code for tokens.
  let accessToken;
  let refreshToken;
  let accessTokenExpireIn;
  let refreshTokenExpireIn;
  try {
    const tokenUrl =
      `${TIKTOK_AUTH_BASE}/api/v2/token/get?app_key=${encodeURIComponent(TIKTOK_APP_KEY)}` +
      `&app_secret=${encodeURIComponent(TIKTOK_APP_SECRET)}` +
      `&auth_code=${encodeURIComponent(authCode)}&grant_type=authorized_code`;

    const tokenResponse = await fetch(tokenUrl);
    const tokenBody = await tokenResponse.json();
    console.log('[tiktok/callback] token/get raw response:', JSON.stringify(tokenBody));

    result.tokenExchange.raw = tokenBody;

    // TikTok returns errors inside HTTP 200s, so `code` in the body is the
    // real signal — not tokenResponse.ok.
    if (!tokenResponse.ok || tokenBody.code !== 0) {
      return res.status(200).send(renderDebugPage(result, 'Token exchange failed'));
    }

    const data = tokenBody.data || {};
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    accessTokenExpireIn = data.access_token_expire_in;
    refreshTokenExpireIn = data.refresh_token_expire_in;
    console.log(
      '[tiktok/callback] raw expire_in values — access_token_expire_in:',
      accessTokenExpireIn,
      'refresh_token_expire_in:',
      refreshTokenExpireIn
    );
    result.tokenExchange.ok = true;
  } catch (err) {
    console.log('[tiktok/callback] token/get threw:', err);
    result.tokenExchange.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Token exchange request threw an exception'));
  }

  // TikTok's token/get returns these as absolute Unix timestamps (seconds),
  // not durations — despite the `_expire_in` naming. Do not add to Date.now().
  result.accessTokenExpiresAt = new Date(accessTokenExpireIn * 1000).toISOString();
  result.refreshTokenExpiresAt = new Date(refreshTokenExpireIn * 1000).toISOString();

  // Sanity check: a correctly-interpreted access token expiry should land
  // within the next few days, never in the past. A value outside that range
  // means TikTok's response format changed (e.g. back to a real duration).
  const accessExpiryMs = accessTokenExpireIn * 1000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (accessExpiryMs < Date.now() || accessExpiryMs > Date.now() + sevenDaysMs) {
    console.warn(
      '[tiktok/callback] access token expiry outside expected range — raw access_token_expire_in:',
      accessTokenExpireIn,
      'resolved to:',
      result.accessTokenExpiresAt
    );
  }

  // 2. Look up the authorized shop(s) — shop_cipher is required on nearly
  // every subsequent TikTok Shop business API call, so it must be captured now.
  let shopId;
  let shopName;
  let shopCipher;
  let isSandbox;
  try {
    const path = '/authorization/202309/shops';
    const timestamp = Math.floor(Date.now() / 1000);
    const signParams = { app_key: TIKTOK_APP_KEY, timestamp };
    const sign = generateSign(path, signParams);

    const shopsUrl =
      `${TIKTOK_API_BASE}${path}?app_key=${encodeURIComponent(TIKTOK_APP_KEY)}` +
      `&timestamp=${timestamp}&sign=${sign}`;

    const shopsResponse = await fetch(shopsUrl, {
      headers: {
        'content-type': 'application/json',
        'x-tts-access-token': accessToken,
      },
    });
    const shopsBody = await shopsResponse.json();
    console.log('[tiktok/callback] authorized-shops raw response:', JSON.stringify(shopsBody));

    result.authorizedShops.raw = shopsBody;

    if (!shopsResponse.ok || shopsBody.code !== 0) {
      return res.status(200).send(renderDebugPage(result, 'Authorized-shops lookup failed'));
    }

    const shop = (shopsBody.data && shopsBody.data.shops && shopsBody.data.shops[0]) || {};
    shopId = shop.id ?? shop.shop_id;
    shopName = shop.name ?? shop.shop_name;
    shopCipher = shop.cipher ?? shop.shop_cipher;

    const sandboxDetection = detectIsSandbox(shop, shopName);
    isSandbox = sandboxDetection.isSandbox;
    console.log(
      `[tiktok/callback] sandbox detection: isSandbox=${isSandbox}, decided by ${sandboxDetection.source}`
    );

    result.authorizedShops.ok = true;
    result.shop_id = shopId;
    result.shop_name = shopName;
    result.hasShopCipher = shopCipher != null;
    result.isSandbox = isSandbox;
    result.sandboxSource = sandboxDetection.source;

    if (!shopId || !shopCipher) {
      return res.status(200).send(renderDebugPage(result, 'Authorized-shops response missing shop_id or shop_cipher'));
    }
  } catch (err) {
    console.log('[tiktok/callback] authorized-shops threw:', err);
    result.authorizedShops.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Authorized-shops request threw an exception'));
  }

  // 3. Persist credentials. tiktok_shops is the sole source of truth for
  // TikTok tokens — the stores mirror below never gets access_token/
  // refresh_token written to it.
  try {
    const { error: dbError } = await supabaseAdmin.from('tiktok_shops').upsert(
      {
        shop_id: String(shopId),
        shop_name: shopName,
        shop_cipher: shopCipher,
        access_token: accessToken,
        refresh_token: refreshToken,
        access_token_expires_at: result.accessTokenExpiresAt,
        refresh_token_expires_at: result.refreshTokenExpiresAt,
        is_sandbox: isSandbox,
        user_id: userId,
      },
      { onConflict: 'shop_id' }
    );

    if (dbError) {
      console.log('[tiktok/callback] supabase upsert error:', JSON.stringify(dbError));
      result.dbUpsert.raw = dbError;
      return res.status(200).send(renderDebugPage(result, 'Supabase upsert failed'));
    }

    result.dbUpsert.ok = true;
  } catch (err) {
    console.log('[tiktok/callback] supabase upsert threw:', err);
    result.dbUpsert.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Supabase upsert threw an exception'));
  }

  // 4. Mirror into `stores` — identity/ownership only, never credentials — so
  // orders/sync_logs (FK'd to stores(id)) and the per-store ownership checks
  // every Shopee endpoint already does against `stores.user_id` work for a
  // TikTok shop with no code changes elsewhere. Then link tiktok_shops back
  // to the mirror row via store_id.
  try {
    const { data: storeRow, error: storeError } = await supabaseAdmin
      .from('stores')
      .upsert(
        {
          user_id: userId,
          platform: 'tiktok',
          shop_id: String(shopId),
          shop_name: shopName,
          is_active: true,
        },
        { onConflict: 'user_id,platform,shop_id' }
      )
      .select('id')
      .single();

    if (storeError) {
      console.log('[tiktok/callback] stores mirror upsert error:', JSON.stringify(storeError));
      result.storeMirror.raw = storeError;
      return res.status(200).send(renderDebugPage(result, 'Stores mirror upsert failed'));
    }

    result.store_id = storeRow.id;

    const { error: linkError } = await supabaseAdmin
      .from('tiktok_shops')
      .update({ store_id: storeRow.id })
      .eq('shop_id', String(shopId));

    if (linkError) {
      console.log('[tiktok/callback] tiktok_shops.store_id link error:', JSON.stringify(linkError));
      result.storeMirror.raw = linkError;
      return res.status(200).send(renderDebugPage(result, 'Failed to link tiktok_shops.store_id'));
    }

    result.storeMirror.ok = true;
  } catch (err) {
    console.log('[tiktok/callback] stores mirror threw:', err);
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
    ['Authorized-shops lookup succeeded', result.authorizedShops.ok],
    ['tiktok_shops upsert succeeded', result.dbUpsert.ok],
    ['stores mirror written', result.storeMirror.ok],
  ];

  const failedRaw = [
    ['tokenExchange', result.tokenExchange],
    ['authorizedShops', result.authorizedShops],
    ['dbUpsert', result.dbUpsert],
    ['storeMirror', result.storeMirror],
  ].filter(([, step]) => !step.ok && step.raw != null);

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>TikTok Shop OAuth Debug</title>
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
<h1>TikTok Shop OAuth — Debug</h1>
${fatalError ? `<p class="fail"><strong>${esc(fatalError)}</strong></p>` : '<p class="ok"><strong>All steps completed successfully.</strong></p>'}
<table>
<tr><th>Step</th><th>Status</th></tr>
${rows.map(([label, ok]) => `<tr><td>${esc(label)}</td><td class="${ok ? 'ok' : 'fail'}">${ok ? 'OK' : 'FAILED'}</td></tr>`).join('\n')}
</table>
<table>
<tr><th>Field</th><th>Value</th></tr>
<tr><td>shop_id</td><td>${esc(result.shop_id)}</td></tr>
<tr><td>shop_name</td><td>${esc(result.shop_name)}</td></tr>
<tr><td>shop_cipher present</td><td class="${result.hasShopCipher ? 'ok' : 'fail'}">${result.hasShopCipher}</td></tr>
<tr><td>access_token_expires_at</td><td>${esc(result.accessTokenExpiresAt)}</td></tr>
<tr><td>refresh_token_expires_at</td><td>${esc(result.refreshTokenExpiresAt)}</td></tr>
<tr><td>is_sandbox</td><td>${esc(result.isSandbox)}</td></tr>
<tr><td>is_sandbox decided by</td><td>${esc(result.sandboxSource)}</td></tr>
<tr><td>stores.id (mirror row)</td><td>${esc(result.store_id)}</td></tr>
</table>
${failedRaw.map(([name, step]) => `<h2>Raw response — ${esc(name)}</h2><pre>${esc(JSON.stringify(step.raw, null, 2))}</pre>`).join('\n')}
</body>
</html>`;
}
