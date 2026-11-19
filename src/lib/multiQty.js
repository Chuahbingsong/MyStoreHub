// The ONE place that decides "this line has more than one piece to pack" and
// how that looks. Orders (card + detail sheet) and Scan import from here, so
// the threshold and colours can't drift between screens.
//
// Purely presentational: nothing here touches data — it only reads the
// quantity and variant name a page already has. A line is "multi" when its
// quantity is 2+ OR its variant name says 2+ pieces ("2pcs", "Set of 2"); the
// badge then shows the real pieces to pack (qty × pieces per unit).
//
// Pink because every other hue on an order is already spoken for: red = New
// Orders count / cancel requests / failures, orange = Shopee / retry, amber =
// returns, yellow = in process, violet = Website / instant, blue = Lazada /
// primary. #993556 is a deep berry that reads clearly apart from red-500 and
// orange-500 at a glance.

export const MULTI_QTY_MIN = 2

// Reference values. The Tailwind classes below spell the same hex literally
// because Tailwind's JIT only picks up complete class strings in source —
// change a colour here AND in the matching class below.
export const MULTI_QTY_COLORS = {
  badge: '#993556',
  tint: '#FBEAF0',
}

// Light pink behind a quantity-2+ item row (detail sheet, Scan).
export const MULTI_QTY_LINE_CLS = 'bg-[#FBEAF0]'
// Detail-sheet rows have no padding of their own, so the tint is bled a few px
// past the row's edges with a same-pink ring (a box-shadow) — no padding or
// margin, so row size and spacing stay exactly as they were. Not used on Scan,
// whose item rows are already padded cards.
export const MULTI_QTY_ROW_BLEED_CLS = 'ring-[6px] ring-[#FBEAF0]'
// Filled "x2" badge. Inherits font size from wherever the quantity already
// sits, so it slots into the existing text without resizing it.
export const MULTI_QTY_BADGE_CLS = 'inline-block rounded-md bg-[#993556] px-1.5 leading-tight text-white'

// Small "xN" overlaid on the bottom-right corner of an Orders-card photo.
// Sits inside the photo's bounds (the photo row scrolls, so anything hanging
// outside would be clipped) and its corner radius matches the photo's.
export const MULTI_QTY_THUMB_BADGE_CLS =
  'pointer-events-none absolute bottom-0 right-0 rounded-tl-md rounded-br-lg bg-[#993556] px-1 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white'

// Variant name: darker and heavier than the old grey secondary text, so it
// reads at a glance while packing. Size is set per context.
export const VARIANT_CLS = 'font-semibold text-[#374151]'

// A variant claiming more pieces than this is a multipack sold as ONE item
// ("100pcs stickers" is one bag), or a size/model number that happens to read
// like a count ("X200"). Not highlighted.
export const VARIANT_PIECES_MAX = 20

// Piece-count phrases, matched against the lowercased variant name. Each one
// captures the count N. Lookbehinds keep N from being the tail of a bigger
// number ("12pcs" is 12, not 2) or of a word ("rtx2080" never reads as x2).
const PIECE_PATTERNS = [
  // "2pcs", "2 pcs", "3pc", "2 pieces", "2件", "2 biji"
  /(?<![\d.])(\d+)\s?(?:pcs?|pieces?|biji)(?![a-z])/g,
  // Chinese counters: "2件", "2件套", "2个", "2个装"
  /(?<![\d.])(\d+)\s?[件个]/g,
  // "set of 2"
  /(?<![a-z])set\s?of\s?(\d+)(?![\d.])/g,
  // "x2", "x 2", "×2" — not "60x90cm" (x after a number), not "rtx2" (x
  // inside a word), not "x2m"/"x 2 cm" (a dimension).
  /(?<![a-z0-9.])(?<!\d\s)[x×]\s?(\d+)(?![\d.a-z])(?!\s?(?:mm|cm|m|ml|l|g|kg|v|w|mah|gb|tb|inch|in|ft)(?![a-z]))/g,
  // Deliberately NOT "2 in 1" / "3in1": that is usually one combined item.
]

/**
 * THE detection: how many pieces one unit of this variant is, when its name
 * says 2 or more ("2pcs", "Set of 2", "x2", "2件", …). null when it names no
 * piece count, names only 1, or names more than VARIANT_PIECES_MAX. With
 * several counts in one name the largest wins. Cases: multiQty.test.js.
 */
export function piecesInVariant(variant) {
  if (!variant) return null
  const text = String(variant).toLowerCase()
  let best = null
  for (const pattern of PIECE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const n = Number(match[1])
      if (n >= MULTI_QTY_MIN && n <= VARIANT_PIECES_MAX && (best === null || n > best)) best = n
    }
  }
  return best
}

/** Pieces to actually pack: quantity × pieces per unit (1 when unstated). */
export function piecesToPack(qty, variant) {
  return (Number(qty) || 0) * (piecesInVariant(variant) ?? 1)
}

/** Pink when the line holds 2+ pieces — by quantity OR by the variant name. */
export function isMultiQty(qty, variant) {
  return (Number(qty) || 0) >= MULTI_QTY_MIN || piecesInVariant(variant) !== null
}
