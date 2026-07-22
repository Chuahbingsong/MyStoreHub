// Local, per-browser preferences — not synced to Supabase.

const AUTO_SYNC_ORDERS_KEY = 'mystorehub:autoSyncOrders'

// Default ON: absence of the key (first run, or a browser that's never
// toggled it) should behave as if the user opted in.
export function getAutoSyncOrdersEnabled() {
  const raw = localStorage.getItem(AUTO_SYNC_ORDERS_KEY)
  return raw === null ? true : raw === 'true'
}

export function setAutoSyncOrdersEnabled(enabled) {
  localStorage.setItem(AUTO_SYNC_ORDERS_KEY, String(enabled))
}

const LOCALE_KEY = 'mystorehub:locale'
export const SUPPORTED_LOCALES = ['en', 'zh-CN']
const DEFAULT_LOCALE = 'en'

// Default 'en': absence of the key (first run, or a browser that's never
// toggled it) keeps English as the default experience. An unrecognized
// stored value (stale build, hand-edited localStorage) falls back to the
// default rather than handing an unknown locale string to the i18n layer.
export function getLocale() {
  const raw = localStorage.getItem(LOCALE_KEY)
  return SUPPORTED_LOCALES.includes(raw) ? raw : DEFAULT_LOCALE
}

export function setLocale(locale) {
  localStorage.setItem(LOCALE_KEY, locale)
}
