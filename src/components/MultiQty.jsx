import { isMultiQty, MULTI_QTY_BADGE_CLS } from '@/lib/multiQty'
import { useQtyLabels } from '@/hooks/useQtyLabels'

/**
 * The quantity text ("x2"), dropped in exactly where a page already prints it.
 * A single piece renders as the same bare text as before; 2+ pieces — by
 * quantity or by the variant name ("2pcs") — is wrapped in a filled pink
 * badge so a multi-piece line can't be packed as one.
 *
 * When the variant names a piece count the badge reads "x2 sets" and a second
 * pink badge spells out the total ("= 4 pcs total"). `stacked` puts that total
 * on its own line (detail sheet, Scan); otherwise it follows inline (the
 * one-line Orders summary, which truncates).
 */
export function QtyMark({ qty, variant, prefix = 'x', stacked = false }) {
  const labels = useQtyLabels()
  if (!isMultiQty(qty, variant)) {
    return (
      <>
        {prefix}
        {qty}
      </>
    )
  }
  const { qty: qtyText, total } = labels(qty, variant, prefix)
  return (
    <>
      <span className={MULTI_QTY_BADGE_CLS}>{qtyText}</span>
      {total &&
        (stacked ? (
          <span className="mt-1 block">
            <span className={MULTI_QTY_BADGE_CLS}>{total}</span>
          </span>
        ) : (
          <>
            {' '}
            <span className={MULTI_QTY_BADGE_CLS}>{total}</span>
          </>
        ))}
    </>
  )
}
