import { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } from '../_lib/shopee.js';
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { withCors } from '../_lib/cors.js';

// Combines what used to be api/shopee/auth.js and api/shopee/callback.js into
// one Vercel function (dispatched on ?action=) to stay under the Hobby plan's
// 12-function cap. This flow is live — behaviour of each branch is unchanged
// from the originals.
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

async function handleCallback(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, shop_id } = req.query;

  if (!code || !shop_id) {
    return res.status(400).json({ error: 'Missing code or shop_id' });
  }

  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp);

  const tokenUrl =
    `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}` +
    `&timestamp=${timestamp}&sign=${sign}`;

  const shopIdNumber = Number(shop_id);
  const partnerIdNumber = Number(SHOPEE_PARTNER_ID);

  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: shopIdNumber,
      partner_id: partnerIdNumber,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || tokenData.error) {
    return res.status(502).json({ error: 'Shopee token exchange failed', details: tokenData });
  }

  const { access_token, refresh_token, expire_in } = tokenData;
  const tokenExpiresAt = new Date(Date.now() + expire_in * 1000).toISOString();

  const { error: dbError } = await supabaseAdmin.from('stores').upsert(
    {
      user_id: '82ccf862-7385-4e73-aa8a-df2923e3c4dd',
      platform: 'shopee',
      shop_id: String(shop_id),
      access_token,
      refresh_token,
      token_expires_at: tokenExpiresAt,
      is_active: true,
    },
    { onConflict: 'user_id,platform,shop_id' }
  );

  if (dbError) {
    return res.status(500).json({ error: 'Failed to save store', details: dbError });
  }

  res.writeHead(302, { Location: '/settings?connected=shopee' });
  return res.end();
}
