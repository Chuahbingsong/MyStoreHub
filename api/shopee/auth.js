import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from '../_lib/shopee.js';
import { withCors } from '../_lib/cors.js';

export default withCors(handler);

function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp);
  const redirect = encodeURIComponent(process.env.SHOPEE_REDIRECT_URL);

  const baseString = `${SHOPEE_PARTNER_ID}${path}${timestamp}`;
  console.log('[shopee/auth] partner_id:', SHOPEE_PARTNER_ID);
  console.log('[shopee/auth] timestamp:', timestamp);
  console.log('[shopee/auth] baseString:', baseString);
  console.log('[shopee/auth] sign:', sign);

  const authUrl =
    `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}` +
    `&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;

  return res.status(200).json({ authUrl });
}
