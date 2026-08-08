import crypto from 'crypto';

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
