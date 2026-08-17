import { useCallback, useEffect, useMemo, useState } from 'react'
import { getLocale, setLocale as persistLocale, SUPPORTED_LOCALES } from '@/lib/preferences'
import { I18nContext } from './I18nContext'
import en from './translations/en'
import zhCN from './translations/zh-CN'

const TRANSLATIONS = { en, 'zh-CN': zhCN }

function resolveKey(dict, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), dict)
}

// Only {{var}} interpolation and the two-form plural selection below — no
// date/number formatting. The app deliberately keeps currency/number
// formatting locale-invariant (RM amounts, tabular figures) regardless of UI
// language, so nothing here should ever localize a number. Dates DO vary by
// locale, but they are formatted in src/lib/i18n/datetime.js rather than here:
// they need date-fns/Intl, which has no business being in the string layer.
function interpolate(template, vars) {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    vars[name] !== undefined ? String(vars[name]) : match
  )
}

// Deliberately TWO forms, not CLDR's six. The only two locales this app
// supports need exactly these: English distinguishes one from everything else,
// and Chinese has no plural inflection at all (both suffixes hold the same
// string — see dashboard.platforms.orderCount_* for the shape). Adding
// _zero/_few/_many would be dead weight in both dictionaries, and Intl.PluralRules
// would pull in category names neither locale can use. Revisit only if a locale
// with real plural categories (ru, ar, pl) is ever added.
//
// Selection is on `count` specifically — the same variable the string
// interpolates — so a caller can never plural-select on one number while
// displaying another.
function pluralKey(key, count) {
  return `${key}_${count === 1 ? 'one' : 'other'}`
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => getLocale())

  const setLocale = useCallback((next) => {
    if (!SUPPORTED_LOCALES.includes(next)) return
    setLocaleState(next)
    persistLocale(next)
  }, [])

  // index.html ships lang="en" (the default locale) so the very first paint is
  // never mislabelled; this corrects it on mount and on every switch. Without
  // it the document claims English to screen readers, browser translation
  // prompts and CJK font/line-breaking heuristics even in Chinese.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // A key missing from the active locale's dictionary falls back to English
  // rather than rendering blank or the raw dot-path — most likely to happen
  // mid-rollout, while only some pages have been converted to zh-CN keys.
  const t = useCallback(
    (key, vars) => {
      const active = TRANSLATIONS[locale] ?? TRANSLATIONS.en

      // A plural lookup is attempted only when the caller passes a numeric
      // `count` AND the bare key holds no string of its own. That ordering
      // means an exact key always wins, so a caller that already passes a
      // fully-suffixed key (or a non-plural key that happens to take a count)
      // keeps resolving exactly as before.
      const lookup = (dict) => {
        const direct = resolveKey(dict, key)
        if (typeof direct === 'string') return direct
        if (typeof vars?.count === 'number') return resolveKey(dict, pluralKey(key, vars.count))
        return undefined
      }

      const value = lookup(active) ?? lookup(TRANSLATIONS.en)

      if (typeof value !== 'string') {
        console.error(`[i18n] missing translation for key "${key}" in both "${locale}" and "en"`)
        return key
      }

      return interpolate(value, vars)
    },
    [locale]
  )

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
