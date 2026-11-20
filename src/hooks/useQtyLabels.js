import { multiQtyLabels } from '@/lib/multiQty'
import { useTranslation } from '@/lib/i18n/I18nContext'

/**
 * multiQtyLabels() bound to the active locale: `{ qty, total, thumb }` for a
 * pink multi-qty line ("x2 sets" / "= 4 pcs total" / "4 pcs", or plain "x2"
 * with no total when the variant names no piece count). Shared by QtyMark and
 * the Orders-card photo badge so the two can't disagree. The logic lives in
 * src/lib/multiQty.js so it stays import-free and runnable under `npm test`.
 */
export function useQtyLabels() {
  const { t } = useTranslation()
  return (qty, variant, prefix = 'x') => multiQtyLabels(qty, variant, t, prefix)
}
