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
// { groups: [{ storeId, orderSnList }], orderSnList, meta, armedAt }
// `groups` exists because Print All Unprinted spans several stores and
// confirm-awb-printed is scoped to one; `orderSnList` is kept as the flat
// list of every SN so existing callers can still read a count off it.
let pending = null
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
 * Normalises either call shape into groups: a single store's
 * { storeId, orderSnList }, or a cross-store { groups: [...] }.
 */
function toGroups({ storeId, orderSnList, groups }) {
  if (groups?.length) {
    return groups.filter((group) => group.storeId && group.orderSnList?.length)
  }
  if (storeId && orderSnList?.length) return [{ storeId, orderSnList }]
  return []
}

/**
 * Arms the "mark as printed?" prompt for the next foreground resume.
 * Native only — see finalizeAwbDelivery below for the browser/PWA path.
 * A new call replaces whatever was pending, so only the most recent print
 * can ever surface a prompt.
 *
 * Accepts one store ({ storeId, orderSnList }) or several
 * ({ groups: [{ storeId, orderSnList }] }) — the latter for a print run that
 * spans stores.
 */
export function armPendingPrint({ storeId, orderSnList, groups, meta }) {
  if (!isNativePlatform()) return
  const resolved = toGroups({ storeId, orderSnList, groups })
  if (resolved.length === 0) return

  ensureResumeListener()
  pending = {
    groups: resolved,
    orderSnList: resolved.flatMap((group) => group.orderSnList),
    meta: meta ?? null,
    armedAt: Date.now(),
  }
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
  const { groups } = pending
  pending = null
  promptVisible = false
  notify()

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return

  // One call per store: confirm-awb-printed validates a single store's
  // ownership, so a cross-store run cannot be confirmed in one request.
  for (const group of groups) {
    await confirmAwbPrinted(session.access_token, group.storeId, group.orderSnList)
  }
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
export async function finalizeAwbDelivery({ storeId, accessToken, orderSnList, groups, meta }) {
  if (isNativePlatform()) {
    armPendingPrint({ storeId, orderSnList, groups, meta })
    return
  }

  for (const group of toGroups({ storeId, orderSnList, groups })) {
    await confirmAwbPrinted(accessToken, group.storeId, group.orderSnList)
  }
}
