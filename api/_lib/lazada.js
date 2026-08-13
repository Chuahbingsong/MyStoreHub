import crypto from 'crypto';
import { supabaseAdmin } from './supabaseAdmin.js';

export const LAZADA_APP_KEY = (process.env.LAZADA_APP_KEY || '').trim();
export const LAZADA_APP_SECRET = (process.env.LAZADA_APP_SECRET || '').trim();
export const LAZADA_REDIRECT_URI = (process.env.LAZADA_REDIRECT_URI || '').trim();

export const LAZADA_AUTH_HOST = 'https://auth.lazada.com';
export const LAZADA_API_HOST = 'https://api.lazada.com/rest';

export const LAZADA_TOKEN_CREATE_PATH = '/auth/token/create';
export const LAZADA_TOKEN_REFRESH_PATH = '/auth/token/refresh';

/**
 * Lazada Open Platform request signature. Unlike TikTok's generateSign (which
 * wraps the app secret around BOTH ends of the base string and lowercases the
 * digest), Lazada's scheme is a plain HMAC-SHA256: sort every param (except
 * `sign`) alphabetically by key, concatenate as
 * `${apiPath}${key1}${value1}${key2}${value2}...`, HMAC-SHA256 that string
 * keyed with the app secret, and hex-encode the digest UPPERCASE. Every
 * Lazada API call — including the OAuth token endpoints, which need a valid
 * sign before any access_token exists — must be signed with this.
 */
export function generateSign(apiPath, params = {}) {
  const signParams = { ...params };
  delete signParams.sign;

  const sortedKeys = Object.keys(signParams).sort();
  const baseString = apiPath + sortedKeys.map((key) => `${key}${signParams[key]}`).join('');

  return crypto.createHmac('sha256', LAZADA_APP_SECRET).update(baseString).digest('hex').toUpperCase();
}

// A stored access token gets refreshed once it's within this much of its
// expiry, not only once it's actually expired — same convention as
// api/_lib/tiktok.js's REFRESH_THRESHOLD_MS.
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_SYNC_TYPE = 'lazada_token_refresh';

// Unlike tiktok_shops (no store_id-shaped FK usable at refresh time, so
// TikTok's refresh logging leaves store_id null and carries shop_id in
// `message` instead), lazada_shops always has store_id populated by the
// callback before any refresh can run — so sync_logs gets a real store_id
// here, matching every other sync_logs writer in this app.
async function logRefreshStart(storeId) {
  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .insert({
      store_id: storeId,
      sync_type: TOKEN_REFRESH_SYNC_TYPE,
      status: 'started',
      message: null,
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[lazada] failed to write sync_logs start row for store', storeId, error);
    return null;
  }
  return data.id;
}

async function logRefreshComplete(logId, status, message) {
  if (!logId) return;

  const { error } = await supabaseAdmin.from('sync_logs').update({ status, message }).eq('id', logId);

  if (error) {
    console.warn('[lazada] failed to update sync_logs completion row', logId, error);
  }
}

/**
 * Reads the stored refresh_token for a Lazada shop (looked up by seller_id),
 * exchanges it for a fresh access/refresh token pair via Lazada's
 * /auth/token/refresh endpoint, and writes the new tokens + expiry
 * timestamps back to lazada_shops.
 *
 * Lazada's token endpoints return expires_in and refresh_expires_in as
 * DURATIONS in seconds (the opposite of TikTok's token/get, which returns
 * absolute Unix timestamps despite the same `_expire_in`-shaped naming) — so
 * expiry here is computed as Date.now() + value * 1000, never
 * `new Date(value * 1000)`.
 */
export async function refreshLazadaToken(sellerId) {
  const { data: shop, error: shopError } = await supabaseAdmin
    .from('lazada_shops')
    .select('refresh_token, store_id')
    .eq('seller_id', sellerId)
    .maybeSingle();

  if (shopError) throw new Error(`Failed to load lazada_shops row: ${shopError.message}`);
  if (!shop) throw new Error(`No lazada_shops row found for seller_id ${sellerId}`);
  if (!shop.refresh_token) throw new Error('Stored refresh_token is missing');

  const logId = await logRefreshStart(shop.store_id);

  try {
    const timestamp = String(Date.now());
    const params = {
      app_key: LAZADA_APP_KEY,
      refresh_token: shop.refresh_token,
      sign_method: 'sha256',
      timestamp,
    };
    const sign = generateSign(LAZADA_TOKEN_REFRESH_PATH, params);

    const url = `${LAZADA_AUTH_HOST}/rest${LAZADA_TOKEN_REFRESH_PATH}?${new URLSearchParams({ ...params, sign }).toString()}`;

    const response = await fetch(url, { method: 'POST' });
    const body = await response.json();
    console.log('[lazada] auth/token/refresh raw response:', JSON.stringify(body));

    // Lazada returns errors inside HTTP 200s, so the body's own `code` field
    // is the real signal — not response.ok. Success responses either omit
    // `code` entirely or carry "0"; anything else (or a missing access_token)
    // is a failure.
    if (!response.ok || !body.access_token || (body.code && body.code !== '0')) {
      throw new Error(`Token refresh failed: ${JSON.stringify(body)}`);
    }

    const accessToken = body.access_token;
    const refreshToken = body.refresh_token;
    const expiresIn = body.expires_in;
    const refreshExpiresIn = body.refresh_expires_in;

    console.log(
      '[lazada] raw duration values — expires_in:',
      expiresIn,
      'refresh_expires_in:',
      refreshExpiresIn
    );

    const accessTokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const refreshTokenExpiresAt = refreshExpiresIn
      ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
      : null;

    warnIfExpiryUnexpected(expiresIn, refreshExpiresIn);

    const { error: updateError } = await supabaseAdmin
      .from('lazada_shops')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('seller_id', sellerId);

    if (updateError) throw new Error(`Failed to persist refreshed tokens: ${updateError.message}`);

    await logRefreshComplete(logId, 'success', `refreshed — access_token_expires_at=${accessTokenExpiresAt}`);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
    };
  } catch (err) {
    console.error('[lazada] refreshLazadaToken failed for seller', sellerId, err);
    await logRefreshComplete(logId, 'error', err.message);
    throw err;
  }
}

// Sanity check: a correctly-interpreted access token expiry should land
// roughly 7 days out and a refresh token roughly 30 days out. Anything far
// outside that band means Lazada's response shape changed (e.g. switched to
// absolute timestamps, TikTok-style) and this file's Date.now() + value*1000
// math would silently produce a garbage expiry.
function warnIfExpiryUnexpected(expiresIn, refreshExpiresIn) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const accessExpiryMs = expiresIn * 1000;
  if (accessExpiryMs < 6 * DAY_MS || accessExpiryMs > 8 * DAY_MS) {
    console.warn(
      '[lazada] access token expires_in outside expected ~7 day range — raw expires_in:',
      expiresIn
    );
  }
  if (refreshExpiresIn != null) {
    const refreshExpiryMs = refreshExpiresIn * 1000;
    if (refreshExpiryMs < 28 * DAY_MS || refreshExpiryMs > 32 * DAY_MS) {
      console.warn(
        '[lazada] refresh token refresh_expires_in outside expected ~30 day range — raw refresh_expires_in:',
        refreshExpiresIn
      );
    }
  }
}

/**
 * Returns a live access token for a Lazada shop (by seller_id), refreshing
 * it first if it's within REFRESH_THRESHOLD_MS of expiry (or already
 * expired). All Lazada API calls that need an access token should go through
 * this instead of reading lazada_shops.access_token directly, so a stale
 * token never reaches Lazada. Lazada's refresh token itself only lives ~30
 * days, so this must run well before that window closes — see the cron wiring
 * in api/cron/sync-all.js, which checks every connected shop on each tick.
 */
export async function getValidLazadaToken(sellerId) {
  const { data: shop, error } = await supabaseAdmin
    .from('lazada_shops')
    .select('access_token, access_token_expires_at')
    .eq('seller_id', sellerId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load lazada_shops row: ${error.message}`);
  if (!shop) throw new Error(`No lazada_shops row found for seller_id ${sellerId}`);

  const expiresAtMs = shop.access_token_expires_at ? new Date(shop.access_token_expires_at).getTime() : 0;
  const needsRefresh = expiresAtMs - Date.now() < REFRESH_THRESHOLD_MS;

  if (needsRefresh) {
    console.log(
      '[lazada] access token for seller',
      sellerId,
      'is within 24h of expiry (or already expired) — refreshing before use'
    );
    const refreshed = await refreshLazadaToken(sellerId);
    return refreshed.access_token;
  }

  return shop.access_token;
}
