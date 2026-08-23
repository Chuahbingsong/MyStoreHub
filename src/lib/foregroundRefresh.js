// Shared "app returned to foreground" signal for cache-then-refresh pages.
//
// Combines @capacitor/app's appStateChange (native) with the browser's
// visibilitychange (web/PWA) behind ONE listener pair, registered once —
// same singleton discipline as the appStateChange listeners already in
// supabase.js (auth token refresh) and awbPrintPrompt.js (the "mark as
// printed?" resume prompt): a module-level guard so remounting a page never
// piles up duplicate native listeners.
//
// Subscribers don't get a bare "you're foregrounded" ping — they get how
// long the app was backgrounded for, and decide for themselves whether that
// clears their own minimum threshold. appStateChange fires on every
// foreground/background transition, including the notification shade, a
// permission dialog, and (in this app) the native AWB "Open with" chooser —
// transitions far too frequent to treat as "go refetch everything".
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'

const isNative = Capacitor.isNativePlatform()

const subscribers = new Set()
let backgroundedAt = null
let listenersRegistered = false

function markBackgrounded() {
  if (backgroundedAt === null) backgroundedAt = Date.now()
}

function markForegroundedAndNotify() {
  const elapsedMs = backgroundedAt === null ? 0 : Date.now() - backgroundedAt
  backgroundedAt = null
  subscribers.forEach((callback) => {
    try {
      callback(elapsedMs)
    } catch (err) {
      console.error('[foreground-refresh] subscriber threw', err)
    }
  })
}

function ensureListeners() {
  if (listenersRegistered) return
  listenersRegistered = true

  if (isNative) {
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) markForegroundedAndNotify()
      else markBackgrounded()
    })
  }

  // Also registered on native: a Capacitor WebView can fire this alongside
  // appStateChange for the same transition. That's harmless here — the
  // second call sees backgroundedAt already cleared and reports elapsedMs 0,
  // which no subscriber's threshold treats as "foregrounded".
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markForegroundedAndNotify()
    else markBackgrounded()
  })
}

/**
 * Subscribe to foreground transitions. `callback(elapsedMs)` fires every time
 * the app/tab becomes visible, with how long it was backgrounded beforehand
 * (0 if it was never backgrounded — e.g. the very first foreground signal
 * after a cold start). Returns an unsubscribe function.
 */
export function subscribeForegroundRefresh(callback) {
  ensureListeners()
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}
