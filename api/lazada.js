import crypto from 'crypto';
import {
  LAZADA_APP_KEY,
  LAZADA_REDIRECT_URI,
  LAZADA_AUTH_HOST,
  LAZADA_TOKEN_CREATE_PATH,
  generateSign,
  // TEMPORARY — used only by the debug probe at the bottom of this file.
  getValidLazadaToken,
} from './_lib/lazada.js';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { withCors } from './_lib/cors.js';

// Combines what would otherwise be api/lazada/auth.js and
// api/lazada/callback.js into one Vercel function (dispatched on ?action=),
// same reasoning as api/tiktok.js: stay under the Hobby plan's 12-function
// cap (underscore-prefixed files under api/_lib/ don't count against it).
export const config = { maxDuration: 60 };

export default withCors(handler);

function handler(req, res) {
  const { action } = req.query;

  if (action === 'auth') return handleAuth(req, res);
  if (action === 'callback') return handleCallback(req, res);
  // TEMPORARY — delete this line together with the probe block at the bottom.
  if (action === 'probe') return handleProbe(req, res);

  return res
    .status(400)
    .json({ error: 'Unknown or missing action. Use ?action=auth, ?action=callback or ?action=probe' });
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

/* ==========================================================================
 * ⚠️  TEMPORARY DEBUG PROBE — DELETE BEFORE/AFTER lazadaSync.js IS BUILT  ⚠️
 * ==========================================================================
 *
 * Everything below this banner exists ONLY to observe Lazada's real response
 * shape before any sync code is written against it. It is throwaway. Nothing
 * else in the app imports it.
 *
 * TO REMOVE, delete exactly three things:
 *   1. this entire block, to the end of the file
 *   2. the `if (action === 'probe')` line in handler()
 *   3. the `getValidLazadaToken` import at the top of this file
 *
 * CALL IT WITH (POST + Bearer, same auth shape as api/tiktok.js's ?action=sync):
 *
 *   curl -X POST 'https://<host>/api/lazada?action=probe' \
 *     -H 'Authorization: Bearer <supabase-session-jwt>' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"days": 7}'
 *
 * Optional body: { days, limit, seller_id }. If 0 orders come back, re-run
 * with a bigger `days` — an empty window answers none of the questions.
 *
 * ⚠️ PRIVACY: this returns and logs Lazada's response bodies UNMODIFIED, on
 * purpose — question 6 is literally "is buyer PII masked or not", and that is
 * unanswerable from a redacted body. So real buyer names/phones/addresses may
 * land in the HTTP response AND in Vercel's function logs. That is the single
 * strongest reason not to leave this deployed. The access token is the one
 * thing that IS redacted, since it is never part of the question.
 * ========================================================================== */

const PROBE_ORDERS_PATH = '/orders/get';
const PROBE_ITEMS_PATH = '/orders/items/get';

const PROBE_DEFAULT_DAYS = 7;
const PROBE_ORDER_LIMIT = 5;

// Lazada's documented per-country gateways. Question 1 is whether these are
// required or whether the generic host in _lib/lazada.js (LAZADA_API_HOST,
// which is currently declared but referenced nowhere) also works.
const PROBE_COUNTRY_GATEWAYS = {
  MY: 'https://api.lazada.com.my/rest',
  SG: 'https://api.lazada.sg/rest',
  TH: 'https://api.lazada.co.th/rest',
  ID: 'https://api.lazada.co.id/rest',
  PH: 'https://api.lazada.com.ph/rest',
  VN: 'https://api.lazada.vn/rest',
};
const PROBE_GENERIC_GATEWAY = 'https://api.lazada.com/rest';

// Lazada wants ISO 8601 WITH an explicit timezone offset (2026-08-09T00:00:00+08:00).
// Date#toISOString() emits milliseconds and a 'Z', which Lazada is documented to
// reject — so build the offset form by hand rather than assuming Z is accepted.
function probeToLazadaIso(date, offsetHours = 8) {
  const shifted = new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offsetHours >= 0 ? '+' : '-';
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.abs(offsetHours))}:00`
  );
}

// Read as text FIRST, then attempt JSON. A wrong gateway host typically answers
// with an HTML error page, and response.json() would throw and destroy the very
// evidence that tells us the host was wrong.
async function probeReadBody(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), nonJsonText: null };
  } catch {
    return { json: null, nonJsonText: text.slice(0, 2000) };
  }
}

function probeRedact(value, accessToken) {
  if (!accessToken) return value;
  return String(value).split(accessToken).join('<ACCESS_TOKEN_REDACTED>');
}

// Lazada signals failure inside HTTP 200s, so the body's own `code` is the real
// signal. Question 2 is whether that code is the STRING "0" or the NUMBER 0 —
// this accepts both precisely so the probe can report which one actually arrived
// rather than pre-judging it.
function probeIsSuccess(body) {
  if (!body || typeof body !== 'object') return false;
  const { code } = body;
  const codeOk = code === undefined || code === null || code === '0' || code === 0;
  return codeOk && body.data !== undefined;
}

/**
 * One GetOrders call.
 *
 * `signAccessToken` is the A/B for question 3: both variants SEND access_token
 * as a query param (Lazada requires that either way), but only one includes it
 * in the signature base string. Exactly one should authenticate — whichever
 * does is the answer.
 */
async function probeCallGetOrders({ host, accessToken, signAccessToken, updateAfter, limit }) {
  const params = {
    app_key: LAZADA_APP_KEY,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    update_after: updateAfter,
    sort_by: 'updated_at',
    sort_direction: 'DESC',
    offset: '0',
    limit: String(limit),
  };

  const signedParams = signAccessToken ? { ...params, access_token: accessToken } : { ...params };
  const sign = generateSign(PROBE_ORDERS_PATH, signedParams);

  const query = new URLSearchParams({ ...params, access_token: accessToken, sign });
  const url = `${host}${PROBE_ORDERS_PATH}?${query.toString()}`;

  const attempt = {
    host,
    signed_access_token: signAccessToken,
    signed_base_string_keys: Object.keys(signedParams).sort(),
    url_sent: probeRedact(url, accessToken),
    http_status: null,
    ok: false,
    raw_body: null,
    non_json_body: null,
    transport_error: null,
  };

  try {
    const response = await fetch(url);
    const { json, nonJsonText } = await probeReadBody(response);
    attempt.http_status = response.status;
    attempt.raw_body = json;
    attempt.non_json_body = nonJsonText;
    attempt.ok = probeIsSuccess(json);
  } catch (err) {
    attempt.transport_error = String(err);
  }

  console.log('[lazada/probe] GetOrders attempt:', JSON.stringify(attempt));
  return attempt;
}

/**
 * One GetMultipleOrderItems call. `numericIds` is the second A/B: Lazada
 * documents order_ids as a JSON array, but whether the ids must be bare numbers
 * ([123,456]) or quoted strings (["123","456"]) is not stated, and GetOrders
 * returns order_id as a string.
 */
async function probeCallGetItems({ host, accessToken, signAccessToken, orderIds, numericIds }) {
  const encodedIds = JSON.stringify(numericIds ? orderIds.map(Number) : orderIds.map(String));

  const params = {
    app_key: LAZADA_APP_KEY,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    order_ids: encodedIds,
  };

  const signedParams = signAccessToken ? { ...params, access_token: accessToken } : { ...params };
  const sign = generateSign(PROBE_ITEMS_PATH, signedParams);

  const query = new URLSearchParams({ ...params, access_token: accessToken, sign });
  const url = `${host}${PROBE_ITEMS_PATH}?${query.toString()}`;

  const attempt = {
    host,
    order_ids_sent: encodedIds,
    id_encoding: numericIds ? 'numeric' : 'string',
    http_status: null,
    ok: false,
    raw_body: null,
    non_json_body: null,
    transport_error: null,
  };

  try {
    const response = await fetch(url);
    const { json, nonJsonText } = await probeReadBody(response);
    attempt.http_status = response.status;
    attempt.raw_body = json;
    attempt.non_json_body = nonJsonText;
    attempt.ok = probeIsSuccess(json);
  } catch (err) {
    attempt.transport_error = String(err);
  }

  console.log('[lazada/probe] GetMultipleOrderItems attempt:', JSON.stringify(attempt));
  return attempt;
}

// Everything below derives the eight answers FROM the observed bodies. It never
// substitutes for the raw bodies, which are returned in full alongside it.
function probeClassifyValue(value) {
  if (value === null || value === undefined) return 'missing';
  const str = String(value);
  if (str.trim() === '') return 'empty';
  if (/^\*+$/.test(str.trim())) return 'fully_masked';
  if (str.includes('*')) return 'partially_masked';
  return 'populated';
}

function probeBuildAnswers({ orderAttempts, itemAttempts, ordersBody, itemsBody }) {
  const winningOrders = orderAttempts.find((a) => a.ok) ?? null;
  const orders = ordersBody?.data?.orders ?? [];
  const firstOrder = orders[0] ?? null;

  // Q1 — working host
  const hostsThatWorked = [...new Set(orderAttempts.filter((a) => a.ok).map((a) => a.host))];
  const q1 = {
    question: 'Which API host worked?',
    answer: hostsThatWorked.length > 0 ? hostsThatWorked : 'NONE — every host failed, see order_attempts[]',
    per_host: orderAttempts.map((a) => ({
      host: a.host,
      signed_access_token: a.signed_access_token,
      ok: a.ok,
      http_status: a.http_status,
      code: a.raw_body?.code ?? null,
      message: a.raw_body?.message ?? a.transport_error ?? null,
    })),
  };

  // Q2 — success code type
  const q2 = {
    question: 'Is the success code the string "0" or numeric 0?',
    answer: winningOrders
      ? {
          value: winningOrders.raw_body?.code,
          javascript_typeof: typeof winningOrders.raw_body?.code,
          verdict:
            typeof winningOrders.raw_body?.code === 'string'
              ? 'STRING "0" — compare with === "0"'
              : typeof winningOrders.raw_body?.code === 'number'
                ? 'NUMBER 0 — compare with === 0'
                : 'code field ABSENT on success — presence of data is the only signal',
        }
      : 'unknown — no successful call',
  };

  // Q3 — access_token in the signature base string
  const signedOk = orderAttempts.some((a) => a.ok && a.signed_access_token);
  const unsignedOk = orderAttempts.some((a) => a.ok && !a.signed_access_token);
  let q3Verdict;
  if (signedOk && !unsignedOk) q3Verdict = 'YES — access_token MUST be in the signature base string';
  else if (!signedOk && unsignedOk) q3Verdict = 'NO — access_token must be sent, but must NOT be signed';
  else if (signedOk && unsignedOk) q3Verdict = 'BOTH variants authenticated — unexpected; inspect order_attempts[]';
  else q3Verdict = 'unknown — neither variant succeeded';
  const q3 = { question: 'Must access_token be in the signature base string?', answer: q3Verdict };

  // Q4 — timestamp format
  const q4 = {
    question: 'Exact format of created_at / updated_at?',
    answer: firstOrder
      ? {
          created_at_literal: firstOrder.created_at ?? null,
          updated_at_literal: firstOrder.updated_at ?? null,
          new_Date_parses_created_at: firstOrder.created_at
            ? !Number.isNaN(new Date(firstOrder.created_at).getTime())
            : null,
          parsed_created_at_iso: firstOrder.created_at
            ? Number.isNaN(new Date(firstOrder.created_at).getTime())
              ? 'UNPARSEABLE by new Date() — needs a manual parser'
              : new Date(firstOrder.created_at).toISOString()
            : null,
        }
      : 'unknown — no orders returned',
  };

  // Q5 — item response shape
  const itemsData = itemsBody?.data;
  let q5Answer = 'unknown — no successful items call';
  if (Array.isArray(itemsData)) {
    const first = itemsData[0];
    if (first && Array.isArray(first.order_items)) {
      q5Answer = {
        shape: 'NESTED — data is an array of per-order objects, each with an order_items[] array',
        per_order_keys: Object.keys(first),
        first_item_keys: first.order_items[0] ? Object.keys(first.order_items[0]) : [],
      };
    } else if (first) {
      q5Answer = {
        shape: 'FLAT — data is a single array of item objects; group by item.order_id yourself',
        first_item_keys: Object.keys(first),
      };
    } else {
      q5Answer = 'data is an empty array — no items for the sampled orders';
    }
  } else if (itemsData && typeof itemsData === 'object') {
    q5Answer = { shape: 'OBJECT — not an array', keys: Object.keys(itemsData) };
  }
  const winningItems = itemAttempts.find((a) => a.ok) ?? null;
  const q5 = {
    question: 'GetMultipleOrderItems: flat item array or nested per-order objects?',
    answer: q5Answer,
    // Second finding from the same call: how order_ids has to be encoded.
    order_ids_encoding: winningItems
      ? {
          accepted: winningItems.id_encoding,
          exact_string_sent: winningItems.order_ids_sent,
          rejected: itemAttempts.filter((a) => !a.ok).map((a) => ({
            id_encoding: a.id_encoding,
            code: a.raw_body?.code ?? null,
            message: a.raw_body?.message ?? a.transport_error ?? null,
          })),
        }
      : 'unknown — no successful items call',
  };

  // Q6 — buyer PII
  const shippingAddress = firstOrder?.address_shipping ?? null;
  const q6 = {
    question: 'Is address_shipping populated or masked? (i.e. does this app have PII approval?)',
    answer: shippingAddress
      ? {
          field_classification: Object.fromEntries(
            Object.entries(shippingAddress).map(([key, value]) => [key, probeClassifyValue(value)])
          ),
          verdict_hint:
            'All "populated" => PII approved. Any "fully_masked"/"partially_masked"/"empty" on ' +
            'first_name/last_name/phone/address1 => PII NOT approved; buyer_name / buyer_phone / ' +
            'shipping_address in the orders table cannot be filled from this scope.',
          raw_address_shipping: shippingAddress,
        }
      : 'unknown — no orders returned, or the order carries no address_shipping key at all',
    customer_name_fields: firstOrder
      ? {
          customer_first_name: probeClassifyValue(firstOrder.customer_first_name),
          customer_last_name: probeClassifyValue(firstOrder.customer_last_name),
        }
      : null,
  };

  // Q7 — statuses multiplicity
  const statusesSeen = orders.map((o) => o.statuses);
  const maxStatuses = statusesSeen.reduce((max, s) => Math.max(max, Array.isArray(s) ? s.length : 0), 0);
  const q7 = {
    question: 'Does statuses[] ever hold more than one value?',
    answer:
      orders.length === 0
        ? 'unknown — no orders returned'
        : {
            max_length_seen: maxStatuses,
            multi_valued_observed: maxStatuses > 1,
            all_statuses_arrays: statusesSeen,
            caveat:
              `Only ${orders.length} order(s) sampled. A single-valued sample does NOT prove ` +
              'statuses is always scalar — a partially-shipped multi-item order is the case that ' +
              'produces two values, so the collapse rule is still needed.',
          },
  };

  // Q8 — quantity vs one-row-per-unit
  let flatItems = [];
  if (Array.isArray(itemsData)) {
    flatItems = itemsData[0] && Array.isArray(itemsData[0].order_items)
      ? itemsData.flatMap((entry) => entry.order_items ?? [])
      : itemsData;
  }
  const firstItem = flatItems[0] ?? null;
  const itemsPerOrder = {};
  for (const item of flatItems) {
    const key = String(item.order_id ?? 'unknown');
    itemsPerOrder[key] = (itemsPerOrder[key] ?? 0) + 1;
  }
  const q8 = {
    question: 'Do items carry a quantity field, or is it one row per unit?',
    answer: firstItem
      ? {
          has_quantity_key: Object.prototype.hasOwnProperty.call(firstItem, 'quantity'),
          quantity_value: firstItem.quantity ?? null,
          all_item_keys: Object.keys(firstItem),
          item_rows_per_order: itemsPerOrder,
          order_items_count_field: Object.fromEntries(
            orders.map((o) => [String(o.order_id), o.items_count ?? null])
          ),
          verdict_hint:
            'Compare item_rows_per_order against order_items_count_field. Equal counts with no ' +
            'quantity key => one row per unit (default quantity to 1, or collapse duplicates).',
        }
      : 'unknown — no items returned',
  };

  return { q1_api_host: q1, q2_success_code: q2, q3_access_token_signed: q3, q4_timestamp_format: q4, q5_items_shape: q5, q6_buyer_pii: q6, q7_statuses_multiplicity: q7, q8_item_quantity: q8 };
}

async function handleProbe(req, res) {
  // Same auth shape as api/tiktok.js's ?action=sync: POST + Bearer session.
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
    console.error('[lazada/probe] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { seller_id: requestedSellerId, days: daysRaw, limit: limitRaw } = req.body ?? {};
  const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0 ? Number(daysRaw) : PROBE_DEFAULT_DAYS;
  const limit =
    Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0 ? Math.min(Number(limitRaw), 50) : PROBE_ORDER_LIMIT;

  // lazada_shops.user_id is stamped by ?action=callback, so scoping on it IS
  // the ownership check. Deliberately NOT .maybeSingle(): the table's unique
  // key is (seller_id, country), so one user can legitimately hold several
  // rows and maybeSingle() would throw on exactly that case.
  let shopQuery = supabaseAdmin
    .from('lazada_shops')
    .select('seller_id, country, store_id, shop_name')
    .eq('user_id', user.id);
  if (requestedSellerId) shopQuery = shopQuery.eq('seller_id', String(requestedSellerId));

  const { data: shops, error: shopsError } = await shopQuery;

  if (shopsError) {
    console.error('[lazada/probe] failed to load lazada_shops', shopsError);
    return res.status(500).json({ success: false, error: 'Failed to load lazada_shops' });
  }
  if (!shops || shops.length === 0) {
    return res.status(404).json({ success: false, error: 'No connected Lazada shop found for this user' });
  }

  const shop = shops[0];
  const country = (shop.country || 'MY').toUpperCase();
  const countryGateway = PROBE_COUNTRY_GATEWAYS[country] ?? null;

  let accessToken;
  try {
    accessToken = await getValidLazadaToken(shop.seller_id);
  } catch (err) {
    console.error('[lazada/probe] could not obtain an access token', err);
    return res.status(502).json({ success: false, error: `Token unavailable: ${err.message}` });
  }

  const updateAfter = probeToLazadaIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

  // Country gateway first, as requested. Both signature variants are run
  // against each host — stopping at the first success would leave question 3
  // unanswered, since a single success can't tell you the other variant fails.
  const hosts = countryGateway ? [countryGateway, PROBE_GENERIC_GATEWAY] : [PROBE_GENERIC_GATEWAY];
  const orderAttempts = [];
  for (const host of hosts) {
    for (const signAccessToken of [true, false]) {
      orderAttempts.push(
        await probeCallGetOrders({ host, accessToken, signAccessToken, updateAfter, limit })
      );
    }
  }

  const winningOrders = orderAttempts.find((a) => a.ok) ?? null;
  const ordersBody = winningOrders?.raw_body ?? null;
  const orders = ordersBody?.data?.orders ?? [];
  const orderIds = orders.map((o) => o.order_id).filter((id) => id !== undefined && id !== null);

  // Items call reuses whatever host + signature variant just authenticated.
  const itemAttempts = [];
  if (winningOrders && orderIds.length > 0) {
    const allNumeric = orderIds.every((id) => /^\d+$/.test(String(id)));
    const encodings = allNumeric ? [true, false] : [false];
    for (const numericIds of encodings) {
      const attempt = await probeCallGetItems({
        host: winningOrders.host,
        accessToken,
        signAccessToken: winningOrders.signed_access_token,
        orderIds,
        numericIds,
      });
      itemAttempts.push(attempt);
      if (attempt.ok) break; // first encoding that works is the answer
    }
  }

  const winningItems = itemAttempts.find((a) => a.ok) ?? null;
  const itemsBody = winningItems?.raw_body ?? null;

  const answers = probeBuildAnswers({ orderAttempts, itemAttempts, ordersBody, itemsBody });

  const payload = {
    _warning: 'TEMPORARY DEBUG PROBE — contains UNREDACTED buyer PII. Remove this endpoint once lazadaSync.js is built.',
    success: Boolean(winningOrders),
    probe_context: {
      seller_id: shop.seller_id,
      shop_name: shop.shop_name,
      country,
      store_id: shop.store_id,
      lazada_shops_rows_for_this_user: shops.length,
      country_gateway_tried: countryGateway ?? '(no gateway known for this country code)',
      generic_gateway_tried: PROBE_GENERIC_GATEWAY,
      window_days: days,
      update_after_sent: updateAfter,
      limit_sent: limit,
      orders_returned: orders.length,
      order_ids_sampled: orderIds,
    },
    answers,
    // The raw, unmodified bodies — the whole point of the probe. Everything in
    // `answers` above is derived from exactly these.
    raw_get_orders_response: ordersBody,
    raw_get_multiple_order_items_response: itemsBody,
    order_attempts: orderAttempts,
    item_attempts: itemAttempts,
  };

  if (orders.length === 0 && winningOrders) {
    payload.hint = `GetOrders authenticated but returned 0 orders in the last ${days} day(s). Re-run with a larger window, e.g. {"days": 90}, or questions 4-8 stay unanswered.`;
  }
  if (!winningOrders) {
    payload.hint = 'No host/signature combination authenticated. Inspect order_attempts[] — each entry carries the exact signed key set, the redacted URL, and Lazada\'s own error body.';
  }

  console.log('[lazada/probe] full payload:', JSON.stringify(payload));

  return res.status(winningOrders ? 200 : 502).json(payload);
}
