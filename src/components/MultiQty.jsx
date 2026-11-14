import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { isMultiQty, MULTI_QTY_BADGE_CLS, MULTI_QTY_PILL_CLS } from '@/lib/multiQty'

/**
 * The quantity on an item line. Quantity 1 stays plain text; 2+ becomes a
 * filled pink badge so a multi-piece line can't be packed as one.
 * `className` carries the per-context size (card vs sheet/Scan).
 */
export function QtyBadge({ qty, className, plainClassName = 'text-[#1F2937]', prefix = 'x', ariaLabel }) {
  const multi = isMultiQty(qty)
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-extrabold tabular-nums leading-none',
        multi ? cn('rounded-md px-2 py-1', MULTI_QTY_BADGE_CLS) : plainClassName,
        className
      )}
    >
      {prefix}
      {qty}
    </span>
  )
}

/** "N pcs" pill for an order that has at least one 2+ line. */
export function PcsPill({ count, className }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold leading-none tabular-nums',
        MULTI_QTY_PILL_CLS,
        className
      )}
    >
      {t('multiQty.pcs', { count })}
    </span>
  )
}
