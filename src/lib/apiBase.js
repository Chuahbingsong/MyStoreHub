// In the browser/PWA the app is served from the same origin as /api, so a
// relative path is correct. The Capacitor APK bundles the built dist/ and
// loads it from a local webview origin with no /api of its own, so it needs
// an absolute URL — baked in at build time via VITE_API_BASE_URL.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

export function apiUrl(path) {
  return `${API_BASE}${path}`
}
