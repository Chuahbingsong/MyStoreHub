import { format, formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { useMemo } from 'react'
import { useTranslation } from './I18nContext'

// Every date/time the app renders goes through this module, so "what locale is
// this timestamp in?" has exactly one answer: the app's locale, from the i18n
// context. Before this existed the answer varied per call site — Sales and
// Dashboard read the app locale, Orders hardcoded English, and Settings/Boost/
// Shipping used bare toLocaleString()/toLocaleTimeString(), which follow the
// DEVICE locale. That last group was the real bug: an English UI on a zh-CN
// phone rendered Chinese timestamps inside otherwise-English pages, and no
// amount of switching the app language could change them.
//
// Amounts are deliberately NOT here. RM figures stay locale-invariant on
// purpose (see the note in I18nProvider.jsx); only dates vary by language.

// The BCP-47 tag handed to Intl. 'en-MY' rather than 'en': this app is
// Malaysia-only (RM, Malaysia-time day boundaries in the sales report), and
// en-MY is already the tag Sales.jsx, Dashboard.jsx and salesReport.js use for
// number grouping — so English dates render day-first, matching every other
// English surface in the app.
function intlLocale(locale) {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-MY'
}

// date-fns takes a locale OBJECT, not a tag, and treats undefined as its
// built-in en-US default — which is what every date-fns call in the app
// resolved to before this module existed.
function dateFnsLocale(locale) {
  return locale === 'zh-CN' ? zhCN : undefined
}

function toDate(value) {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Short absolute stamp for a point in an order's life — "17 Aug 14:30".
 * Returns undefined for a missing/unparseable value so callers can keep using
 * it as a render guard, exactly as Orders' old formatDateLabel did.
 */
export function formatDateTime(locale, value) {
  const d = toDate(value)
  if (!d) return undefined
  return format(d, 'd MMM HH:mm', { locale: dateFnsLocale(locale) })
}

/** Relative distance with a suffix — "about 2 hours ago". */
export function formatRelativeToNow(locale, value) {
  const d = toDate(value)
  if (!d) return ''
  return formatDistanceToNow(d, { addSuffix: true, locale: dateFnsLocale(locale) })
}

/**
 * Full date + time — the "last synced at" / "last boosted at" style stamp.
 * Replaces bare toLocaleString(), which silently followed the device locale.
 */
export function formatTimestamp(locale, value) {
  const d = toDate(value)
  if (!d) return ''
  return d.toLocaleString(intlLocale(locale))
}

/** Clock time only — the "live from Shopee · 14:30:05" stamp. */
export function formatTimeOfDay(locale, value) {
  const d = toDate(value)
  if (!d) return ''
  return d.toLocaleTimeString(intlLocale(locale))
}

// Compact elapsed-time counter for a just-happened action ("5s ago"), distinct
// from formatRelativeToNow's prose. Kept hand-rolled rather than handed to
// date-fns: this reads as a live counter ticking next to a Sync button, where
// date-fns' "less than a minute ago" is both too long for the space and too
// vague to show that a sync just landed.
//
// Two forms per unit, because Chinese does not put a space before the unit and
// English abbreviations are not translatable word-for-word. This is the one
// place in the app where a date string is assembled rather than formatted, so
// it is spelled out here instead of leaking into a page.
const SHORT_AGO = {
  en: { now: 'just now', seconds: (n) => `${n}s ago`, minutes: (n) => `${n}m ago`, hours: (n) => `${n}h ago` },
  'zh-CN': { now: '刚刚', seconds: (n) => `${n} 秒前`, minutes: (n) => `${n} 分钟前`, hours: (n) => `${n} 小时前` },
}

/**
 * @param ms elapsed milliseconds (already a difference, not a timestamp)
 */
export function formatShortAgo(locale, ms) {
  const strings = SHORT_AGO[locale] ?? SHORT_AGO.en
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 5) return strings.now
  if (seconds < 60) return strings.seconds(seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return strings.minutes(minutes)
  return strings.hours(Math.floor(minutes / 60))
}

/**
 * Locale-bound versions of everything above, for components. The bare
 * functions stay exported for the non-component callers (module-level mappers
 * that already receive a locale, such as Orders' mapSupabaseOrder).
 */
export function useDateTime() {
  const { locale } = useTranslation()
  return useMemo(
    () => ({
      locale,
      formatDateTime: (value) => formatDateTime(locale, value),
      formatRelativeToNow: (value) => formatRelativeToNow(locale, value),
      formatTimestamp: (value) => formatTimestamp(locale, value),
      formatTimeOfDay: (value) => formatTimeOfDay(locale, value),
      formatShortAgo: (ms) => formatShortAgo(locale, ms),
    }),
    [locale]
  )
}
