import { useEffect, useRef, useState } from 'react'

const DEFAULT_THRESHOLD = 64
const DEFAULT_MAX_PULL = 96
// How far the finger has to travel past the initial touch before this counts
// as a deliberate pull rather than a tap/jitter. Below this, we don't call
// preventDefault() at all, so an ordinary tap or a scroll that turns out not
// to start at the very top is never interfered with.
const ACTIVATION_PX = 8
// Damps the indicator so it doesn't track the finger 1:1 — pulling feels like
// it has resistance, and it caps out at maxPull well before the finger does.
const RESISTANCE = 0.5

/**
 * Touch-driven pull-to-refresh, scoped to one scrollable container.
 *
 * The gesture only arms when the container is at scrollTop 0 and the finger
 * moves down — anything else (scrolling up, scrolling while not at the top,
 * a multi-touch gesture) is left alone so normal scrolling is never affected.
 * preventDefault() is only called once the pull has moved past ACTIVATION_PX,
 * i.e. once it's unambiguously a pull, not a tap.
 *
 * Listeners are attached with a native addEventListener (not React's
 * onTouchMove prop) because React attaches touch listeners as passive by
 * default — preventDefault() inside a passive listener is silently ignored,
 * which would leave the browser/WebView free to scroll or show its own
 * overscroll effect underneath the custom indicator.
 *
 * onRefresh is read through a ref rather than being an effect dependency, so
 * passing a fresh function identity every render (as Orders.jsx does) never
 * tears down and re-attaches the touch listeners — only `disabled`,
 * `threshold` and `maxPull` do that, and none of those normally change after
 * mount.
 */
export function usePullToRefresh({
  onRefresh,
  threshold = DEFAULT_THRESHOLD,
  maxPull = DEFAULT_MAX_PULL,
  disabled = false,
}) {
  const containerRef = useRef(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isPulling, setIsPulling] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  // Mirrors isRefreshing into a ref so the native handlers below (set up once
  // per [disabled, maxPull, threshold], not per render) always see the
  // current value without needing it in their effect's dependency array.
  const isRefreshingRef = useRef(isRefreshing)
  useEffect(() => {
    isRefreshingRef.current = isRefreshing
  }, [isRefreshing])

  // Gesture bookkeeping lives in a ref (not state) so the touchmove handler
  // can read/update it synchronously without waiting on a re-render.
  const gestureRef = useRef({ startY: 0, tracking: false, activated: false, pull: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el || disabled) return undefined

    const gesture = gestureRef.current

    function reset() {
      gesture.tracking = false
      gesture.activated = false
      gesture.pull = 0
    }

    function onTouchStart(e) {
      if (isRefreshingRef.current || el.scrollTop > 0 || e.touches.length !== 1) return
      gesture.startY = e.touches[0].clientY
      gesture.tracking = true
      gesture.activated = false
      gesture.pull = 0
    }

    function onTouchMove(e) {
      if (!gesture.tracking || isRefreshingRef.current) return
      const deltaY = e.touches[0].clientY - gesture.startY

      if (deltaY <= 0 || el.scrollTop > 0) {
        // No longer a downward pull from the top — bail and let the browser
        // treat whatever happens next as an ordinary scroll.
        reset()
        setIsPulling(false)
        setPullDistance(0)
        return
      }

      if (deltaY < ACTIVATION_PX) return

      // Committed to the pull: stop the page/WebView from also scrolling or
      // showing its own overscroll glow underneath our indicator.
      e.preventDefault()
      gesture.activated = true
      const damped = Math.min(maxPull, (deltaY - ACTIVATION_PX) * RESISTANCE)
      gesture.pull = damped
      setIsPulling(true)
      setPullDistance(damped)
    }

    async function onTouchEnd() {
      if (!gesture.tracking) return
      const wasActivated = gesture.activated
      const finalPull = gesture.pull
      reset()
      setIsPulling(false)

      if (!wasActivated) {
        setPullDistance(0)
        return
      }

      if (finalPull >= threshold) {
        isRefreshingRef.current = true
        setIsRefreshing(true)
        setPullDistance(threshold)
        try {
          await onRefreshRef.current?.()
        } catch (err) {
          console.error('[pull-to-refresh] onRefresh threw', err)
        } finally {
          isRefreshingRef.current = false
          setIsRefreshing(false)
          setPullDistance(0)
        }
      } else {
        setPullDistance(0)
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [disabled, maxPull, threshold])

  return {
    containerRef,
    pullDistance,
    isPulling,
    isRefreshing,
    isReady: pullDistance >= threshold,
    threshold,
  }
}
