// The ONE place that decides "this line / this order has more than one piece
// to pack" and how that looks. Every page that renders order items (Orders
// cards, Orders detail sheet, Scan result) imports from here, so the threshold
// and the colours can't drift between screens.
//
// Purely presentational: nothing here touches data — it only reads the
// quantity a page already has.
//
// Pink was chosen because every other hue on an order is already spoken for:
// red = New Orders count / cancel requests / failures, orange = Shopee / retry,
// amber = returns, yellow = in process, violet = Website / instant, blue =
// Lazada / primary. #993556 is a deep berry that reads clearly apart from
// red-500 and orange-500 at a glance.

export const MULTI_QTY_MIN = 2

// Reference values. The Tailwind classes below spell the same hex literally
// because Tailwind's JIT only picks up complete class strings in source —
// change a colour here AND in the matching class below.
export const MULTI_QTY_COLORS = {
  border: '#993556',
  tint: '#FBEAF0',
  text: '#72243E',
}

// A quantity-2+ item line: pink tint behind the row.
export const MULTI_QTY_LINE_CLS = 'bg-[#FBEAF0]'
// Filled "x2" badge.
export const MULTI_QTY_BADGE_CLS = 'bg-[#993556] text-white'
// Order card outline. The ring doubles the 1px border visually without
// changing the box size, so cards don't jump when the highlight applies.
export const MULTI_QTY_CARD_CLS = 'border-[#993556] ring-1 ring-[#993556]'
// Product photo of a quantity-2+ line in the Orders card's photo row. A real
// border (not a ring) so it stays inside the scroll row and isn't clipped.
export const MULTI_QTY_THUMB_CLS = 'border-2 border-[#993556] bg-[#FBEAF0]'
// "N pcs" pill on the order.
export const MULTI_QTY_PILL_CLS = 'border border-[#993556]/40 bg-[#FBEAF0] text-[#72243E]'

// Variant name styling shared by every item line. Dark and semibold so it reads
// at a glance while packing, one step under the product name (which stays
// bold). Wraps instead of truncating — the variant is the part that tells two
// otherwise-identical lines apart, so it must never be cut off.
export const VARIANT_CLS = 'break-words font-semibold leading-snug text-[#374151]'

export function isMultiQty(qty) {
  return (Number(qty) || 0) >= MULTI_QTY_MIN
}

// Total pieces across an order's lines. Each element only needs a numeric
// quantity; `getQty` adapts to the two item shapes in the app (Orders' mapped
// `qty`, Scan's raw `quantity`). A missing quantity counts as 1, matching how
// both pages already display it.
export function totalQty(items, getQty = (item) => item.qty) {
  return (items ?? []).reduce((sum, item) => sum + (Number(getQty(item)) || 1), 0)
}

export function orderHasMultiQty(items, getQty = (item) => item.qty) {
  return (items ?? []).some((item) => isMultiQty(getQty(item) ?? 1))
}
