import { useCallback, useMemo, useState } from 'react'
import { getLocale, setLocale as persistLocale, SUPPORTED_LOCALES } from '@/lib/preferences'
import { I18nContext } from './I18nContext'
import en from './translations/en'
import zhCN from './translations/zh-CN'

const TRANSLATIONS = { en, 'zh-CN': zhCN }

function resolveKey(dict, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), dict)
}

// Only {{var}} interpolation — no plural rules, no date/number formatting.
// The app deliberately keeps currency/number formatting locale-invariant
// (RM amounts, tabular figures) regardless of UI language, so nothing here
// should ever localize a number.
function interpolate(template, vars) {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    vars[name] !== undefined ? String(vars[name]) : match
  )
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => getLocale())

  const setLocale = useCallback((next) => {
    if (!SUPPORTED_LOCALES.includes(next)) return
    setLocaleState(next)
    persistLocale(next)
  }, [])

  // A key missing from the active locale's dictionary falls back to English
  // rather than rendering blank or the raw dot-path — most likely to happen
  // mid-rollout, while only some pages have been converted to zh-CN keys.
  const t = useCallback(
    (key, vars) => {
      const active = TRANSLATIONS[locale] ?? TRANSLATIONS.en
      const value = resolveKey(active, key) ?? resolveKey(TRANSLATIONS.en, key)

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
