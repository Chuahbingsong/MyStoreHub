import crypto from 'crypto';
import { TIKTOK_APP_KEY, TIKTOK_REDIRECT_URI, TIKTOK_AUTH_BASE } from '../_lib/tiktok.js';
import { withCors } from '../_lib/cors.js';

export default withCors(handler);

function handler(req, res) {
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
