// In the browser/PWA the app is served from the same origin as /api, so a
// relative path is correct. The Capacitor APK bundles the built dist/ and
// loads it from a local webview origin with no /api of its own, so it needs
// an absolute URL — baked in at build time via VITE_API_BASE_URL.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

export function apiUrl(path) {
  return `${API_BASE}${path}`
}

/**
 * A network-level fetch failure (offline, DNS, CORS block) and a JSON parse
 * failure and a request timeout all land in the same generic `catch` unless
 * distinguished here — otherwise every failure mode shows the same toast,
 * which is what made the CORS break look identical to a Shopee-side error.
 * Always console.error the original err alongside this so the real cause is
 * still inspectable (e.g. via chrome://inspect), even though the toast text
 * stays short.
 */
export function describeRequestError(t, err, fallback) {
  if (err?.name === 'AbortError') return t('errors.timeout')
  if (err instanceof SyntaxError) return t('errors.badResponse')
  if (err instanceof TypeError) return t('errors.unreachable')
  // err.message is the runtime's own text — appended verbatim, never translated.
  return err?.message ? t('errors.withDetail', { fallback, detail: err.message }) : fallback
}
