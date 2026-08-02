// The app now ships as both a same-origin PWA (mystorehub.vercel.app calling
// its own /api routes) and a Capacitor APK, whose WebView serves the bundled
// build from a different origin and so makes genuinely cross-origin requests
// to this API. These endpoints hold the Shopee partner key and can ship
// orders, create flash sales, and toggle couriers — no wildcard origin.
const ALLOWED_ORIGINS = new Set([
  'https://mystorehub.vercel.app',
  'https://localhost', // Capacitor Android default scheme
  'capacitor://localhost', // Capacitor iOS default scheme
]);

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Wraps a Vercel serverless handler so every route answers CORS preflights
 * and reflects an allow-listed origin the same way, instead of each route
 * reimplementing it (or forgetting to).
 */
export function withCors(handler) {
  return async function corsWrappedHandler(req, res) {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    return handler(req, res);
  };
}
