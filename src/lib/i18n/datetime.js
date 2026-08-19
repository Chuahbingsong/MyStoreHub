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

// The two below take a CALENDAR DAY as a bare ISO date ('2026-08-17'), not a
// timestamp — the shape the daily_sales() RPC returns. They are parsed as UTC
// midnight and formatted with timeZone 'UTC' so the label always names the day
// the report meant, rather than sliding to the previous day for anyone whose
// device sits west of UTC. Sales.jsx had both of these inline, each repeating
// intlLocale()'s zh-CN/en-MY choice by hand — the exact per-call-site drift
// this module exists to remove.
function toUtcDay(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Axis/tooltip form — "17 Aug" / "8月17日". */
export function formatDayShort(locale, isoDay) {
  const d = toUtcDay(isoDay)
  if (!d) return ''
  return d.toLocaleDateString(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

/** Table/prose form, with the weekday — "Mon, 17 Aug" / "8月17日周一". */
export function formatDayLong(locale, isoDay) {
  const d = toUtcDay(isoDay)
  if (!d) return ''
  return d.toLocaleDateString(intlLocale(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
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
  en: {
    never: 'never',
    now: 'just now',
    seconds: (n) => `${n}s ago`,
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
    days: (n) => `${n}d ago`,
  },
  'zh-CN': {
    never: '从未',
    now: '刚刚',
    seconds: (n) => `${n} 秒前`,
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    days: (n) => `${n} 天前`,
  },
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
  const hours = Math.floor(minutes / 60)
  // Past a day, "50h ago" stops being readable at a glance.
  if (hours < 24) return strings.hours(hours)
  return strings.days(Math.floor(hours / 24))
}

/**
 * Same counter, but from a TIMESTAMP that may be absent — "synced 5m ago" /
 * "synced never". FlashDeals had this as its own formatRelative(), which
 * duplicated formatShortAgo above in English only, so the whole "Synced ..."
 * column stayed English under zh-CN.
 *
 * @param nowMs current time in ms, passed in so a ticking caller controls the
 *   cadence rather than each call re-reading the clock.
 */
export function formatShortAgoFrom(locale, value, nowMs = Date.now()) {
  const strings = SHORT_AGO[locale] ?? SHORT_AGO.en
  const d = toDate(value)
  if (!d) return strings.never
  return formatShortAgo(locale, nowMs - d.getTime())
}

// Durations, not elapsed time: "ends in 2d 3h", "~4m". Separate from SHORT_AGO
// because these carry no "ago" and are read forward, and because Chinese joins
// the units without the space English needs.
const DURATION = {
  en: { dh: (d, h) => `${d}d ${h}h`, hm: (h, m) => `${h}h ${m}m`, m: (m) => `${m}m` },
  'zh-CN': { dh: (d, h) => `${d}天${h}小时`, hm: (h, m) => `${h}小时${m}分钟`, m: (m) => `${m}分钟` },
}

/** @param ms a span of milliseconds; anything <= 0 reads as zero minutes. */
export function formatDuration(locale, ms) {
  const strings = DURATION[locale] ?? DURATION.en
  if (ms <= 0) return strings.m(0)
  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return strings.dh(days, hours)
  if (hours > 0) return strings.hm(hours, minutes)
  return strings.m(minutes)
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
      formatDayShort: (isoDay) => formatDayShort(locale, isoDay),
      formatDayLong: (isoDay) => formatDayLong(locale, isoDay),
      formatShortAgo: (ms) => formatShortAgo(locale, ms),
      formatShortAgoFrom: (value, nowMs) => formatShortAgoFrom(locale, value, nowMs),
      formatDuration: (ms) => formatDuration(locale, ms),
    }),
    [locale]
  )
}
