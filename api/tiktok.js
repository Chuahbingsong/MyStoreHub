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

// Combines what used to be api/tiktok/auth.js and api/tiktok/callback.js into
// one Vercel function (dispatched on ?action=) to stay under the Hobby plan's
// 12-function cap. Behaviour of each branch is unchanged from the originals.
export default withCors(handler);

function handler(req, res) {
  const { action } = req.query;

  if (action === 'auth') return handleAuth(req, res);
  if (action === 'callback') return handleCallback(req, res);

  return res.status(400).json({ error: 'Unknown or missing action. Use ?action=auth or ?action=callback' });
}

function handleAuth(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const state = crypto.randomBytes(16).toString('hex');

  // Stashed as an httpOnly cookie (not a redirect param) so the callback can
  // check the state it gets back against what THIS browser was issued,
  // rather than trusting whatever state value happens to show up.
  res.setHeader(
    'Set-Cookie',
    `tiktok_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const authUrl =
    `${TIKTOK_AUTH_BASE}/api/v2/authorization?app_key=${encodeURIComponent(TIKTOK_APP_KEY)}` +
    `&state=${state}&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}`;

  res.writeHead(302, { Location: authUrl });
  return res.end();
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

  const { code, auth_code, state } = req.query;
  const authCode = code || auth_code;

  const cookieState = parseCookie(req.headers.cookie, 'tiktok_oauth_state');
  const stateOk = Boolean(state) && Boolean(cookieState) && state === cookieState;

  const result = {
    stateOk,
    tokenExchange: { ok: false, raw: null },
    authorizedShops: { ok: false, raw: null },
    dbUpsert: { ok: false, raw: null },
    shop_id: null,
    shop_name: null,
    hasShopCipher: false,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };

  if (!authCode) {
    return res.status(200).send(renderDebugPage(result, 'Missing code/auth_code in query string'));
  }

  if (!stateOk) {
    console.log('[tiktok/callback] state mismatch', { received: state, expected: cookieState });
    return res.status(200).send(renderDebugPage(result, 'CSRF state mismatch — aborting before token exchange'));
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
    result.tokenExchange.ok = true;
  } catch (err) {
    console.log('[tiktok/callback] token/get threw:', err);
    result.tokenExchange.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Token exchange request threw an exception'));
  }

  result.accessTokenExpiresAt = new Date(Date.now() + accessTokenExpireIn * 1000).toISOString();
  result.refreshTokenExpiresAt = new Date(Date.now() + refreshTokenExpireIn * 1000).toISOString();

  // 2. Look up the authorized shop(s) — shop_cipher is required on nearly
  // every subsequent TikTok Shop business API call, so it must be captured now.
  let shopId;
  let shopName;
  let shopCipher;
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
    result.authorizedShops.ok = true;
    result.shop_id = shopId;
    result.shop_name = shopName;
    result.hasShopCipher = shopCipher != null;

    if (!shopId || !shopCipher) {
      return res.status(200).send(renderDebugPage(result, 'Authorized-shops response missing shop_id or shop_cipher'));
    }
  } catch (err) {
    console.log('[tiktok/callback] authorized-shops threw:', err);
    result.authorizedShops.raw = { error: String(err) };
    return res.status(200).send(renderDebugPage(result, 'Authorized-shops request threw an exception'));
  }

  // 3. Persist.
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
        is_sandbox: true,
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

  return res.status(200).send(renderDebugPage(result, null));
}

function renderDebugPage(result, fatalError) {
  const rows = [
    ['CSRF state check', result.stateOk],
    ['Token exchange succeeded', result.tokenExchange.ok],
    ['Authorized-shops lookup succeeded', result.authorizedShops.ok],
    ['Supabase upsert succeeded', result.dbUpsert.ok],
  ];

  const failedRaw = [
    ['tokenExchange', result.tokenExchange],
    ['authorizedShops', result.authorizedShops],
    ['dbUpsert', result.dbUpsert],
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
</table>
${failedRaw.map(([name, step]) => `<h2>Raw response — ${esc(name)}</h2><pre>${esc(JSON.stringify(step.raw, null, 2))}</pre>`).join('\n')}
</body>
</html>`;
}
