import { isMultiQty, MULTI_QTY_BADGE_CLS } from '@/lib/multiQty'
import { useQtyLabel } from '@/hooks/useQtyLabel'

/**
 * The quantity text ("x2"), dropped in exactly where a page already prints it.
 * A single piece renders as the same bare text as before; 2+ pieces — by
 * quantity or by the variant name ("2pcs") — is wrapped in a filled pink
 * badge so a multi-piece line can't be packed as one.
 */
export function QtyMark({ qty, variant, prefix = 'x' }) {
  const qtyLabel = useQtyLabel()
  if (!isMultiQty(qty, variant)) {
    return (
      <>
        {prefix}
        {qty}
      </>
    )
  }
  return <span className={MULTI_QTY_BADGE_CLS}>{qtyLabel(qty, variant, prefix)}</span>
}
