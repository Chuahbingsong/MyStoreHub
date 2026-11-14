import { isMultiQty, MULTI_QTY_BADGE_CLS } from '@/lib/multiQty'

/**
 * The quantity text ("x2"), dropped in exactly where a page already prints it.
 * Quantity 1 renders as the same bare text as before; 2+ is wrapped in a
 * filled pink badge so a multi-piece line can't be packed as one.
 */
export function QtyMark({ qty, prefix = 'x' }) {
  if (!isMultiQty(qty)) {
    return (
      <>
        {prefix}
        {qty}
      </>
    )
  }
  return (
    <span className={MULTI_QTY_BADGE_CLS}>
      {prefix}
      {qty}
    </span>
  )
}
