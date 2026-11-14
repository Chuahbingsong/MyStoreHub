// The ONE place that decides "this line has more than one piece to pack" and
// how that looks. Orders (card + detail sheet) and Scan import from here, so
// the threshold and colours can't drift between screens.
//
// Purely presentational: nothing here touches data — it only reads the
// quantity a page already has.
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

export function isMultiQty(qty) {
  return (Number(qty) || 0) >= MULTI_QTY_MIN
}
