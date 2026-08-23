import { useEffect, useRef } from 'react'
import { subscribeForegroundRefresh } from '@/lib/foregroundRefresh'

const DEFAULT_MIN_BACKGROUND_MS = 30_000

/**
 * Calls `onForeground` when the app/tab returns to foreground after having
 * been backgrounded for at least `minBackgroundMs` (default 30s). A shorter
 * absence — the notification shade, a permission dialog, the AWB "Open with"
 * chooser — is ignored, since those aren't the user leaving and coming back.
 *
 * `onForeground` is read through a ref, so passing a fresh function identity
 * every render (as Orders.jsx does) doesn't resubscribe on every render.
 */
export function useForegroundRefresh(onForeground, { minBackgroundMs = DEFAULT_MIN_BACKGROUND_MS, enabled = true } = {}) {
  const callbackRef = useRef(onForeground)
  useEffect(() => {
    callbackRef.current = onForeground
  }, [onForeground])

  useEffect(() => {
    if (!enabled) return undefined
    return subscribeForegroundRefresh((elapsedMs) => {
      if (elapsedMs >= minBackgroundMs) callbackRef.current?.()
    })
  }, [enabled, minBackgroundMs])
}
