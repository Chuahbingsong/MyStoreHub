// Defers "mark as printed" to a user-confirmed prompt shown when the app
// resumes after the native AWB "Open with" chooser — Capacitor has no signal
// for "the user actually printed it", only "the app is foreground again".
import { useSyncExternalStore } from 'react'
import { App } from '@capacitor/app'
import { supabase } from '@/lib/supabase'
import { confirmAwbPrinted, isNativePlatform } from '@/lib/awb'

// A resume this long after arming is treated as unrelated to the print that
// armed it (e.g. the app sat backgrounded for hours) rather than the
// chooser flow completing — avoids surfacing a stale prompt out of nowhere.
const PENDING_PRINT_TIMEOUT_MS = 10 * 60 * 1000

// Module-level by design: the prompt must survive the printing page
// unmounting (e.g. user navigates away) between arming and the resume event,
// and it must reset to nothing on a fresh app launch — which it does for
// free by living only in memory, never persisted to disk.
let pending = null // { storeId, orderSnList, meta, armedAt }
let promptVisible = false
let listenerRegistered = false
const listeners = new Set()

function notify() {
  listeners.forEach((listener) => listener())
}

function getSnapshot() {
  return promptVisible ? pending : null
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function ensureResumeListener() {
  if (listenerRegistered) return
  listenerRegistered = true
  App.addListener('appStateChange', ({ isActive }) => {
    // appStateChange fires on every foreground/background transition, not
    // just "returning from the chooser" — only act on it if a print is
    // actually pending, and only once per arm (promptVisible guards that).
    if (!isActive || !pending || promptVisible) return
    if (Date.now() - pending.armedAt > PENDING_PRINT_TIMEOUT_MS) {
      pending = null
      return
    }
    promptVisible = true
    notify()
  })
}

/**
 * Arms the "mark as printed?" prompt for the next foreground resume.
 * Native only — see finalizeAwbDelivery below for the browser/PWA path.
 * A new call replaces whatever was pending, so only the most recent print
 * can ever surface a prompt.
 */
export function armPendingPrint({ storeId, orderSnList, meta }) {
  if (!isNativePlatform() || !orderSnList?.length) return
  ensureResumeListener()
  pending = { storeId, orderSnList, meta: meta ?? null, armedAt: Date.now() }
  promptVisible = false
}

/** React binding: null unless a resume just surfaced an armed print. */
export function usePendingAwbPrint() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Marks the pending orders printed and clears the prompt. Call sites should
 * read the pending value themselves (e.g. via usePendingAwbPrint) before
 * calling this if they need it for their own post-confirm UI updates
 * (see BulkPrint.jsx's `meta` usage) — this clears state before returning.
 */
export async function confirmPendingAwbPrint() {
  if (!pending) return
  const { storeId, orderSnList } = pending
  pending = null
  promptVisible = false
  notify()

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return

  await confirmAwbPrinted(session.access_token, storeId, orderSnList)
}

/** Cancel = order stays unmarked, no error; the PDF was still delivered. */
export function dismissPendingAwbPrint() {
  pending = null
  promptVisible = false
  notify()
}

/**
 * Single entry point callers use right after deliverPdf() resolves.
 * Native: defer marking printed until the resume prompt is confirmed.
 * Browser/PWA: unchanged — mark immediately, there's no reliable resume
 * signal there to hang a prompt off of.
 */
export async function finalizeAwbDelivery({ storeId, accessToken, orderSnList, meta }) {
  if (isNativePlatform()) {
    armPendingPrint({ storeId, orderSnList, meta })
    return
  }
  await confirmAwbPrinted(accessToken, storeId, orderSnList)
}
