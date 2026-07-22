import { createContext, useContext } from 'react'

// Split from I18nProvider.jsx: react-refresh/only-export-components requires
// a component file to export components only — the context object and the
// useTranslation hook live here so I18nProvider.jsx can stay component-only.
export const I18nContext = createContext(null)

export function useTranslation() {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useTranslation must be used within an I18nProvider')
  }
  return ctx
}
