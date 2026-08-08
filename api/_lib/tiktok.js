import crypto from 'crypto';
import { supabaseAdmin } from './supabaseAdmin.js';

export const TIKTOK_APP_KEY = (process.env.TIKTOK_APP_KEY || '').trim();
export const TIKTOK_APP_SECRET = (process.env.TIKTOK_APP_SECRET || '').trim();
export const TIKTOK_REDIRECT_URI = (process.env.TIKTOK_REDIRECT_URI || '').trim();

export const TIKTOK_AUTH_BASE = 'https://auth.tiktok-shops.com';
export const TIKTOK_API_BASE = 'https://open-api.tiktokglobalshop.com';

/**
 * TikTok Shop Open API signature. Per TikTok's spec (not a generic HMAC):
 * the base string is `path` + every query param except `sign` and
 * `access_token`, sorted by key and concatenated as `${key}${value}`, plus
 * the raw JSON body if any — then the app secret is concatenated onto BOTH
 * ends of that base string before HMAC-SHA256 keyed with the app secret,
 * lowercase hex digest.
 */
export function generateSign(path, params = {}, body) {
  const signParams = { ...params };
  delete signParams.sign;
  delete signParams.access_token;

  const sortedKeys = Object.keys(signParams).sort();
  const paramString = sortedKeys.map((key) => `${key}${signParams[key]}`).join('');

  let baseString = `${path}${paramString}`;
  if (body && typeof body === 'string' && body.length > 0) {
    baseString += body;
  }

  const wrapped = `${TIKTOK_APP_SECRET}${baseString}${TIKTOK_APP_SECRET}`;

  return crypto.createHmac('sha256', TIKTOK_APP_SECRET).update(wrapped).digest('hex').toLowerCase();
}

// A stored access token gets refreshed once it's within this much of its
// expiry, not only once it's actually expired — so a call that starts just
// before expiry doesn't race TikTok invalidating the token mid-flight.
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_SYNC_TYPE = 'tiktok_token_refresh';

// Mirrors shopeeSync.js's logSyncStart/logSyncComplete convention: a row
// written BEFORE the refresh call, updated in place after. A row stuck at
// 'started' with no completion is the signature of a hard Vercel timeout
// killing the process mid-refresh, which would otherwise leave zero trace.
async function logRefreshStart(shopId) {
  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .insert({ store_id: shopId, sync_type: TOKEN_REFRESH_SYNC_TYPE, status: 'started' })
    .select('id')
    .single();

  if (error) {
    console.error('[tiktok] failed to write sync_logs start row', error);
    return null;
  }
  return data.id;
}

async function logRefreshComplete(logId, status, message) {
  if (!logId) return;

  const { error } = await supabaseAdmin.from('sync_logs').update({ status, message }).eq('id', logId);

  if (error) {
    console.error('[tiktok] failed to update sync_logs completion row', logId, error);
  }
}

/**
 * Reads the stored refresh_token for a TikTok shop, exchanges it for a fresh
 * access/refresh token pair via TikTok's token/refresh endpoint, and writes
 * the new tokens + expiry timestamps back to tiktok_shops.
 *
 * TikTok's token/get and token/refresh both return access_token_expire_in and
 * refresh_token_expire_in as absolute Unix timestamps in seconds (despite the
 * `_expire_in` naming) — convert with `new Date(value * 1000)`, never add to
 * Date.now(). See api/tiktok.js's callback handler for the same convention.
 */
export async function refreshTikTokToken(shopId) {
  const logId = await logRefreshStart(shopId);

  try {
    const { data: shop, error: shopError } = await supabaseAdmin
      .from('tiktok_shops')
      .select('refresh_token')
      .eq('shop_id', shopId)
      .maybeSingle();

    if (shopError) throw new Error(`Failed to load tiktok_shops row: ${shopError.message}`);
    if (!shop) throw new Error(`No tiktok_shops row found for shop_id ${shopId}`);
    if (!shop.refresh_token) throw new Error('Stored refresh_token is missing');

    const refreshUrl =
      `${TIKTOK_AUTH_BASE}/api/v2/token/refresh?app_key=${encodeURIComponent(TIKTOK_APP_KEY)}` +
      `&app_secret=${encodeURIComponent(TIKTOK_APP_SECRET)}` +
      `&refresh_token=${encodeURIComponent(shop.refresh_token)}&grant_type=refresh_token`;

    const response = await fetch(refreshUrl);
    const body = await response.json();
    console.log('[tiktok] token/refresh raw response:', JSON.stringify(body));

    // TikTok returns errors inside HTTP 200s, so `code` in the body is the
    // real signal — not response.ok.
    if (!response.ok || body.code !== 0) {
      throw new Error(`Token refresh failed: ${JSON.stringify(body)}`);
    }

    const data = body.data || {};
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const accessTokenExpireIn = data.access_token_expire_in;
    const refreshTokenExpireIn = data.refresh_token_expire_in;

    console.log(
      '[tiktok] raw expire_in values — access_token_expire_in:',
      accessTokenExpireIn,
      'refresh_token_expire_in:',
      refreshTokenExpireIn
    );

    const accessTokenExpiresAt = new Date(accessTokenExpireIn * 1000).toISOString();
    const refreshTokenExpiresAt = new Date(refreshTokenExpireIn * 1000).toISOString();

    // Sanity check: a correctly-interpreted access token expiry should land
    // within the next few days, never in the past. Outside that range means
    // TikTok's response format changed (e.g. reverted to a real duration).
    const accessExpiryMs = accessTokenExpireIn * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (accessExpiryMs < Date.now() || accessExpiryMs > Date.now() + sevenDaysMs) {
      console.warn(
        '[tiktok] refreshed access token expiry outside expected range — raw access_token_expire_in:',
        accessTokenExpireIn,
        'resolved to:',
        accessTokenExpiresAt
      );
    }

    const { error: updateError } = await supabaseAdmin
      .from('tiktok_shops')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
      })
      .eq('shop_id', shopId);

    if (updateError) throw new Error(`Failed to persist refreshed tokens: ${updateError.message}`);

    await logRefreshComplete(
      logId,
      'success',
      `refreshed — access_token_expires_at=${accessTokenExpiresAt}`
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
    };
  } catch (err) {
    console.error('[tiktok] refreshTikTokToken failed for shop', shopId, err);
    await logRefreshComplete(logId, 'error', err.message);
    throw err;
  }
}

/**
 * Returns a live access token for a TikTok shop, refreshing it first if it's
 * within REFRESH_THRESHOLD_MS of expiry (or already expired). All TikTok API
 * calls that need an access token should go through this instead of reading
 * tiktok_shops.access_token directly, so a stale token never reaches TikTok.
 */
export async function getValidTikTokToken(shopId) {
  const { data: shop, error } = await supabaseAdmin
    .from('tiktok_shops')
    .select('access_token, access_token_expires_at')
    .eq('shop_id', shopId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load tiktok_shops row: ${error.message}`);
  if (!shop) throw new Error(`No tiktok_shops row found for shop_id ${shopId}`);

  const expiresAtMs = shop.access_token_expires_at ? new Date(shop.access_token_expires_at).getTime() : 0;
  const needsRefresh = expiresAtMs - Date.now() < REFRESH_THRESHOLD_MS;

  if (needsRefresh) {
    console.log(
      '[tiktok] access token for shop',
      shopId,
      'is within 24h of expiry (or already expired) — refreshing before use'
    );
    const refreshed = await refreshTikTokToken(shopId);
    return refreshed.access_token;
  }

  return shop.access_token;
}
