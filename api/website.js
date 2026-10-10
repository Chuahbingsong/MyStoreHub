import {
  readRawBody,
  assertRawBodyUsable,
  verifyDelivery,
  validatePayload,
  applyDelivery,
} from './_lib/websiteOrders.js';

// Webhook endpoint for catsplaytoy.com order events — the 'website' platform.
//
//   POST https://mystorehub.vercel.app/api/website
//
// A thin route: ordering, status codes and what gets told to an unauthenticated
// caller live here; everything else is in api/_lib/websiteOrders.js.
//
// NOT wrapped in withCors(). Every other route here is called by the PWA or the
// Capacitor WebView and needs an allow-listed Origin reflected back; this one is
// called server-to-server by catsplaytoy.com, which sends no Origin and needs no
// CORS headers. Wrapping it would also answer OPTIONS preflights for an endpoint
// no browser should ever be invoking.
//
// FUNCTION BUDGET: this is the 12th serverless function in this project, which
// is the Vercel Hobby ceiling. Anything added later has to hang off an existing
// route's ?action= parameter (as api/lazada.js and api/tiktok.js do) or move
// into api/_lib/.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // ---------------------------------------------------------------------------
  // 1. Method. POST only — a GET on a webhook endpoint is a misconfiguration or
  //    a prod, never a delivery, and must not reveal anything.
  // ---------------------------------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---------------------------------------------------------------------------
  // 2. Raw body, FIRST — before req.body is touched by anything, including an
  //    innocent-looking log line. The signature covers the exact bytes and this
  //    runtime offers no way to opt out of its body parser (both facts probed;
  //    see readRawBody()).
  // ---------------------------------------------------------------------------
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[website] failed to read request body', err);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  const rawBodyProblem = assertRawBodyUsable(req, rawBody);
  if (rawBodyProblem) {
    // 500, not 401: this is OUR problem, and the sender SHOULD retry — by then
    // the deploy that caused it may be rolled back. Separated from a signature
    // failure precisely so this never gets misdiagnosed as a bad secret.
    console.error(`[website] ${rawBodyProblem}`);
    return res.status(500).json({ error: 'Server could not verify the request' });
  }

  // Logged on every delivery so the very first production call confirms the
  // probe's finding still holds there (vercel dev emulates the runtime, it is
  // not the runtime). A sudden run of `raw_bytes=0` is the signature of the
  // failure mode above.
  console.log(
    `[website] delivery ${req.headers['x-delivery-id'] ?? '(none)'} ` +
      `event=${req.headers['x-event'] ?? '(none)'} raw_bytes=${rawBody.length}`
  );

  // ---------------------------------------------------------------------------
  // 3. Authenticate. Nothing below this point has touched the database, and
  //    nothing above it trusted the payload.
  // ---------------------------------------------------------------------------
  const verdict = verifyDelivery({
    rawBody,
    timestampHeader: req.headers['x-timestamp'],
    signatureHeader: req.headers['x-signature'],
  });

  if (!verdict.ok) {
    // The reason goes to OUR logs only. The response says nothing about which
    // check failed, how far off a clock is, or whether the secret is configured
    // — an unauthenticated caller gets a flat refusal.
    console.error(`[website] rejected delivery: ${verdict.reason}`);
    const body = verdict.status === 500 ? { error: 'Server misconfigured' } : { error: 'Unauthorized' };
    return res.status(verdict.status).json(body);
  }

  // ---------------------------------------------------------------------------
  // 4. Parse and validate. Parsed from the raw bytes we verified, NOT from
  //    req.body — req.body is the parser's interpretation of a body we never
  //    authenticated, and using it here would mean verifying one thing and
  //    storing another.
  // ---------------------------------------------------------------------------
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.error('[website] signed delivery had an unparseable JSON body');
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }

  const invalid = validatePayload(payload);
  if (invalid) {
    // 400 means the sender keeps retrying a payload that cannot work, which is
    // the deliberate choice: a visible retry loop is recoverable, whereas
    // answering 2xx here would drop a real order silently and permanently.
    // Nothing was claimed, so a corrected re-send with the same delivery_id
    // still goes through.
    console.error(`[website] invalid payload: ${invalid}`);
    return res.status(400).json({ error: invalid });
  }

  const deliveryId = req.headers['x-delivery-id'];
  if (typeof deliveryId !== 'string' || deliveryId.trim() === '') {
    // Without it there is no idempotency key, so a retry would be applied as a
    // fresh delivery. Signed-but-unusable, so it is a 400 like the above.
    console.error('[website] signed delivery had no X-Delivery-Id');
    return res.status(400).json({ error: 'Missing X-Delivery-Id' });
  }

  // ---------------------------------------------------------------------------
  // 5. Apply. 'duplicate' and 'stale' are successes — they both mean "we
  //    already have this" — so only a thrown error becomes a retry.
  // ---------------------------------------------------------------------------
  try {
    const result = await applyDelivery({
      payload,
      headers: {
        deliveryId: deliveryId.trim(),
        event: req.headers['x-event'],
      },
      // Leaves headroom inside maxDuration so the response is always sent by
      // us rather than cut off by the platform mid-push.
      deadline: Date.now() + 20_000,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // 5xx on purpose: the sender retries with the same delivery_id, and
    // applyDelivery() has already released its claim so the retry can redo the
    // work instead of being waved through as a duplicate.
    console.error('[website] delivery failed — returning 500 so it is retried', err);
    return res.status(500).json({ error: 'Failed to apply delivery' });
  }
}
