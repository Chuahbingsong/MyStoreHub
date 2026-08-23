import { RefreshCw } from 'lucide-react'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { cn } from '@/lib/utils'

/**
 * Wraps a scrollable page region with a touch pull-to-refresh gesture and a
 * visible indicator (pull / release / refreshing states). The wrapped div
 * becomes the scroll container itself — pass your scroll/height classes
 * (e.g. "flex-1 overflow-y-auto") via `className`; this component adds
 * `overscroll-y-contain` so Android's WebView overscroll glow doesn't fight
 * the custom indicator underneath it.
 *
 * `onRefresh` may return a promise — the indicator stays in the refreshing
 * state until it resolves. Reusable across pages: only Orders uses it today,
 * but nothing here is Orders-specific.
 */
export default function PullToRefresh({
  onRefresh,
  children,
  className,
  disabled,
  threshold,
  maxPull,
}) {
  const { t } = useTranslation()
  const { containerRef, pullDistance, isPulling, isRefreshing, isReady, threshold: effectiveThreshold } =
    usePullToRefresh({ onRefresh, disabled, threshold, maxPull })

  const indicatorHeight = isRefreshing ? effectiveThreshold : pullDistance
  const showLabel = indicatorHeight > 4

  return (
    <div ref={containerRef} className={cn('overscroll-y-contain', className)}>
      <div
        aria-hidden={!isPulling && !isRefreshing}
        style={{
          height: indicatorHeight,
          transition: isPulling ? 'none' : 'height 200ms ease-out',
        }}
        className="flex items-center justify-center overflow-hidden"
      >
        {showLabel && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#6B7280]">
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
              style={
                !isRefreshing
                  ? { transform: `rotate(${Math.min(1, indicatorHeight / effectiveThreshold) * 180}deg)` }
                  : undefined
              }
            />
            <span>
              {isRefreshing
                ? t('pullToRefresh.refreshing')
                : isReady
                  ? t('pullToRefresh.release')
                  : t('pullToRefresh.pull')}
            </span>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
