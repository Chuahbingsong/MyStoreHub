// Client-side Web Push: capability detection, subscribe, and unsubscribe.
//
// The subscription itself is stored server-side in Supabase (push_subscriptions
// table) so the cron sender can reach this device. This module only handles the
// browser half — asking the push service for a subscription and tearing it
// down. Settings.jsx owns the Supabase read/write and the toggle UI.

import { supabase } from '@/lib/supabase'
import { getLocale } from '@/lib/preferences'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY

// True only where the full push stack exists. On iOS/iPadOS this is still false
// in a normal Safari tab — see isIosNeedsInstall() — so the UI can tell "this
// browser can't do push at all" apart from "this iPhone needs Home-Screen
// install first".
export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// iOS/iPadOS only exposes PushManager to a Home-Screen-installed PWA (iOS
// 16.4+), never a Safari tab. Detect the case where the user is on iOS in a
// browser tab (not standalone) so Settings can show an "Add to Home Screen"
// hint instead of a dead toggle.
export function isIosNeedsInstall() {
  if (typeof navigator === 'undefined') return false
  const isIos =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; distinguish by touch support.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  return isIos && !isStandalone && !isPushSupported()
}

// VAPID public keys are transmitted as base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

async function getRegistration() {
  // The SW is registered by vite-plugin-pwa (injectRegister: 'auto'); wait for
  // it to be ready rather than registering a second one.
  return navigator.serviceWorker.ready
}

// Returns true if THIS browser already has an active push subscription. Used to
// initialise the toggle's on/off state.
export async function getExistingSubscription() {
  if (!isPushSupported()) return null
  const registration = await getRegistration()
  return registration.pushManager.getSubscription()
}

/**
 * Requests permission (must be called from a user gesture), subscribes to the
 * push service, and upserts the subscription into Supabase for the given user.
 *
 * Returns { ok, reason }. reason is 'unsupported' | 'denied' | 'no-key' |
 * 'error' on failure so the caller can show the right message.
 */
export async function enablePush(userId) {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' }
  if (!VAPID_PUBLIC_KEY) {
    console.error('[push] VITE_VAPID_PUBLIC_KEY is not set')
    return { ok: false, reason: 'no-key' }
  }

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return { ok: false, reason: 'denied' }
    }

    const registration = await getRegistration()

    // Reuse an existing subscription if the browser already has one; otherwise
    // create a fresh one. userVisibleOnly is mandatory for Chrome.
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }

    const json = subscription.toJSON()

    // onConflict endpoint: the same device re-enabling just refreshes its row
    // (keys can rotate) rather than creating a duplicate. RLS requires user_id
    // = auth.uid(), so this only ever writes the caller's own row.
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
        // Captured so the server-side cron can format the notification body in
        // this device's language — the React i18n layer isn't in scope there.
        locale: getLocale(),
      },
      { onConflict: 'endpoint' }
    )

    if (error) {
      console.error('[push] failed to save subscription', error)
      // Roll back the browser subscription so state stays consistent with the
      // server (no orphaned subscription that the server can't reach).
      await subscription.unsubscribe().catch(() => {})
      return { ok: false, reason: 'error' }
    }

    return { ok: true }
  } catch (err) {
    console.error('[push] enable failed', err)
    return { ok: false, reason: 'error' }
  }
}

/**
 * Unsubscribes this browser and deletes its row from Supabase. Best-effort on
 * both halves: a failure on one shouldn't strand the other.
 */
export async function disablePush() {
  if (!isPushSupported()) return { ok: true }

  try {
    const registration = await getRegistration()
    const subscription = await registration.pushManager.getSubscription()

    if (subscription) {
      // Delete the server row first (while we still know the endpoint), then
      // tear down the browser subscription.
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', subscription.endpoint)

      if (error) {
        console.error('[push] failed to delete subscription row', error)
      }

      await subscription.unsubscribe().catch((err) => {
        console.error('[push] unsubscribe failed', err)
      })
    }

    return { ok: true }
  } catch (err) {
    console.error('[push] disable failed', err)
    return { ok: false }
  }
}
