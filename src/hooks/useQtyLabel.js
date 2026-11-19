import { piecesInVariant, piecesToPack } from '@/lib/multiQty'
import { useTranslation } from '@/lib/i18n/I18nContext'

/**
 * The text inside a pink multi-qty badge: the real pieces to pack. "x6 pcs"
 * when the variant names a piece count (qty × pieces per unit), otherwise the
 * plain "x2". Shared by QtyMark and the Orders-card photo badge so the two
 * can't disagree. Kept out of src/lib/multiQty.js so that file stays
 * import-free and runnable under `npm test`.
 */
export function useQtyLabel() {
  const { t } = useTranslation()
  return (qty, variant, prefix = 'x') =>
    piecesInVariant(variant) === null
      ? `${prefix}${qty}`
      : t('multiQty.pieces', { prefix, count: piecesToPack(qty, variant) })
}
