import crypto from 'crypto';

export const SHOPEE_PARTNER_ID = (process.env.SHOPEE_PARTNER_ID || '').trim();
export const SHOPEE_PARTNER_KEY = (process.env.SHOPEE_PARTNER_KEY || '').trim();
export const SHOPEE_API_BASE =
  (process.env.SHOPEE_API_BASE || 'https://partner.test-stable.shopeemobile.com').trim();

/**
 * Generates the HMAC-SHA256 signature required by Shopee Open API v2.
 * Public APIs (e.g. auth) omit accessToken/shopId; shop APIs require both.
 */
export function generateSign(path, timestamp, accessToken, shopId) {
  const baseString =
    accessToken && shopId
      ? `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`
      : `${SHOPEE_PARTNER_ID}${path}${timestamp}`;

  return crypto
    .createHmac('sha256', SHOPEE_PARTNER_KEY)
    .update(baseString)
    .digest('hex');
}
