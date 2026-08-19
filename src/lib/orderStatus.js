// Canonical order-status vocabulary and the per-platform raw->key mapping.
//
// Extracted from Orders.jsx so it has ONE home. Orders still owns the tabs, the
// badges and the tab-bucketing rationale; what lives here is only the part that
// more than one page needs. Scan renders the same statuses and Dashboard maps
// the same raw Shopee values, and three copies of a mapping this fiddly is
// exactly the drift the comments below keep warning about. Scan in particular
// had no mapping at all: it rendered `order_status` straight off the row, so a
// seller scanning a parcel read "READY_TO_SHIP" rather than "To Pack".
//
// Nothing here renders. Every value is a STABLE KEY; the display label is
// resolved by the caller through t(`status.<key>`).

// Canonical status KEYS. These are stable identifiers and are NEVER rendered:
// every map that keys off an order's status keys off one of these, so the
// display wording can change — reworded, translated — without moving an order
// between tabs, changing a badge colour or disarming a button guard.
//
// Before this existed the canonical English label did both jobs at once
// ('To Pack' was simultaneously what the user read and what STATUS_TO_TAB was
// keyed by), which made the labels untranslatable: the first translated label
// would have silently emptied a tab. Dashboard.jsx hit exactly this and was
// fixed the same way — see SHOPEE_STATUS_KEY / STATUS_CLASS there.
//
// The values are the dictionary keys under the shared `status:` namespace, so
// a label lookup is t(`status.${statusKey}`).
export const STATUS = {
  UNPAID: 'unpaid',
  INVOICE_PENDING: 'invoicePending',
  TO_PACK: 'toPack',
  PACKED: 'packed',
  RETRY_SHIPMENT: 'retryShipment',
  SHIPPED: 'shipped',
  TO_CONFIRM_RECEIPT: 'toConfirmReceipt',
  COMPLETED: 'completed',
  CANCEL_REQUESTED: 'cancelRequested',
  RETURN_REQUESTED: 'returnRequested',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
}

// Shopee v2 order_status enum, audited against this list (source: Shopee
// Open Platform v2 order.get_order_detail / get_order_list docs, plus
// TO_CONFIRM_RECEIVE observed live in this shop's data). Every value here is
// mapped; if Shopee ships a new one, mapSupabaseOrder() warns and routes it
// to the "Other" tab instead of dropping it.
export const SHOPEE_STATUS_MAP = {
  UNPAID: STATUS.UNPAID,
  INVOICE_PENDING: STATUS.INVOICE_PENDING,
  READY_TO_SHIP: STATUS.TO_PACK,
  PROCESSED: STATUS.PACKED,
  RETRY_SHIP: STATUS.RETRY_SHIPMENT,
  SHIPPED: STATUS.SHIPPED,
  TO_CONFIRM_RECEIVE: STATUS.TO_CONFIRM_RECEIPT,
  COMPLETED: STATUS.COMPLETED,
  TO_RETURN: STATUS.RETURN_REQUESTED,
  IN_CANCEL: STATUS.CANCEL_REQUESTED,
  CANCELLED: STATUS.CANCELLED,
}

// TikTok Shop Orders API (v202309) order_status enum — all nine documented
// values — mapped to the same shared canonical labels SHOPEE_STATUS_MAP uses,
// so tab bucketing and badge styling work identically across platforms.
//
// This is the ONLY place a TikTok status is translated. api/_lib/tiktokSync.js
// writes TikTok's raw value straight into orders.order_status, exactly as the
// Shopee sync does with Shopee's. It used to convert into Shopee's vocabulary
// first, which meant two tables mapped the same thing and disagreed: the sync
// wrote READY_TO_SHIP/PROCESSED/SHIPPED, this table has no keys for those, and
// so every TikTok order in those states silently fell through to "Other".
// If a status ever needs remapping, it changes here and nowhere else.
//
// Two values were resolved when the duplicate table was removed:
//   ON_HOLD  -> 'Unpaid' (was 'Invoice Pending' here). ON_HOLD means TikTok
//     has suspended the order — payment/risk review — and the seller CANNOT
//     ship it. 'Invoice Pending' buckets into "New Orders" with a red,
//     act-now badge, which is exactly wrong. The Unpaid tab is the one whose
//     stated meaning is "nothing the seller can do until the platform moves
//     it", so ON_HOLD belongs there.
//   DELIVERED -> 'To Confirm Receipt' (the sync said 'Shipped'). The parcel
//     has arrived but the buyer hasn't confirmed and the order hasn't settled
//     — that is precisely Shopee's TO_CONFIRM_RECEIVE. Both labels bucket
//     into the Shipped tab anyway, so this is a display-precision win only.
//
// Still best-effort from TikTok's documented enum — unlike SHOPEE_STATUS_MAP
// above, it has NOT been audited against a live sandbox order, so verify it
// against real TikTok order data before depending on it for fulfilment
// decisions. TikTok exposes cancellations/returns through a separate
// Return/Refund object rather than a top-level order_status value, so there's
// no TikTok analogue for Shopee's IN_CANCEL/TO_RETURN buckets here — an order
// in one of those states falls through to the "Other" tab via the same
// unmapped-status fallback below until that's wired up.
export const TIKTOK_STATUS_MAP = {
  UNPAID: STATUS.UNPAID,
  ON_HOLD: STATUS.UNPAID,
  AWAITING_SHIPMENT: STATUS.TO_PACK,
  PARTIALLY_SHIPPING: STATUS.PACKED,
  AWAITING_COLLECTION: STATUS.PACKED,
  IN_TRANSIT: STATUS.SHIPPED,
  DELIVERED: STATUS.TO_CONFIRM_RECEIPT,
  COMPLETED: STATUS.COMPLETED,
  CANCELLED: STATUS.CANCELLED,
}

// Lazada's raw status vocabulary, mapped to the same shared canonical labels
// SHOPEE_STATUS_MAP uses. api/_lib/lazadaSync.js writes Lazada's raw status
// straight into orders.order_status — this is the single translation layer, the
// same arrangement Shopee has and the one TikTok was fixed to use.
//
// Lazada's `statuses` field is an ARRAY (a part-shipped order can carry
// ["shipped","pending"]); lazadaSync.js collapses it least-progressed-wins
// BEFORE writing, so the values arriving here are always scalar.
//
// Every value below was seen in, or confirmed against, live data — `confirmed`
// in particular is absent from Lazada's published status list but appeared in
// the live sample.
//
// Two mappings are lossy, because Lazada simply has no equivalent state:
//   delivered -> 'Completed'. Lazada has NO status after delivered — it is the
//     end state for a fulfilled order. (TikTok maps DELIVERED to 'To Confirm
//     Receipt' instead, and that asymmetry is correct: TikTok has a real
//     COMPLETED status afterwards, Lazada does not. Mapping this to 'To Confirm
//     Receipt' would leave the Completed tab permanently empty for Lazada.)
//   failed -> 'Cancelled'. ⚠️ The weakest mapping here. Lazada's `failed` may
//     mean a failed DELIVERY (parcel coming back, arguably still actionable) or
//     a failed ORDER (payment/fraud, genuinely dead). Treated as terminal for
//     now; re-check this one against live data before trusting it. If it turns
//     out to mean failed DELIVERY, it belongs with the return group below.
//
// THE RETURN GROUP: returned, shipped_back, shipped_back_success and
// package_returned all map to 'Returned' (Returns tab).
//
// `returned` used to map to 'Cancelled', on the reasoning that a COMPLETED
// return implies no outstanding action and the Returns tab implies one. That
// was wrong in practice: it hid physically-returning stock inside a tab that
// reads as "dead orders, nothing to do", when a returned parcel still needs
// receiving, inspecting and restocking. The Returns tab now covers the whole
// return lifecycle — 'Return Requested' at the front (a decision is pending),
// 'Returned' at the back (goods are on their way back or already back) — and
// Cancelled is reserved for orders where no goods ever moved.
//
// The four are collapsed into one label deliberately: `shipped_back` is in
// transit back while the other three are complete, so calling all four
// 'Returned' runs slightly ahead of reality for that one. That is the same
// many-to-one lossiness this table already carries elsewhere (packed and
// ready_to_ship both -> 'Packed'), and it keeps a canonical label from existing
// for a single platform's single status. Split it if the in-transit-back case
// ever needs its own handling.
//
// Still deliberately unmapped: lost_by_3pl, damaged_by_3pl and friends. Those
// are loss/damage claims, not returns — they land in the "Other" tab with the
// warning below rather than being forced into a bucket they don't belong in.
export const LAZADA_STATUS_MAP = {
  unpaid: STATUS.UNPAID,
  pending: STATUS.TO_PACK,
  // 'Completed', NOT 'To Pack' — do not "fix" this back without new evidence.
  //
  // `confirmed` is an order/payment-level state, not a fulfilment state. It is
  // absent from Lazada's published item-status vocabulary, and it never
  // advances: an order that ships and is delivered keeps reporting `confirmed`
  // at order level forever, while the real progress shows up only in per-item
  // status (which api/_lib/lazadaSync.js now reads instead — see
  // deriveOrderStatus there).
  //
  // EVIDENCE (2026-08-17): 146 orders were stored as `confirmed`, spanning May
  // to August, nearly all carrying tracking numbers. Lazada Seller Centre showed
  // exactly ONE order actually needing seller action over that whole period, and
  // that one was stored as `ready_to_ship`, not `confirmed`. So `confirmed`
  // reliably means settled business, and mapping it to 'To Pack' flooded the New
  // Orders tab with months of finished orders — burying the single order that
  // did need packing.
  //
  // 'Completed' is the honest bucket for a settled order whose fulfilment detail
  // is unavailable. It is deliberately the QUIET choice: the failure mode of
  // over-reporting completion is a finished order sitting in the wrong tab,
  // whereas the failure mode of 'To Pack' was hiding real work in the noise.
  confirmed: STATUS.COMPLETED,
  packed: STATUS.PACKED,
  ready_to_ship: STATUS.PACKED,
  shipped: STATUS.SHIPPED,
  delivered: STATUS.COMPLETED,
  canceled: STATUS.CANCELLED,
  returned: STATUS.RETURNED,
  shipped_back: STATUS.RETURNED,
  shipped_back_success: STATUS.RETURNED,
  package_returned: STATUS.RETURNED,
  failed: STATUS.CANCELLED,
}

export const RAW_STATUS_MAP_BY_PLATFORM = {
  shopee: SHOPEE_STATUS_MAP,
  tiktok: TIKTOK_STATUS_MAP,
  lazada: LAZADA_STATUS_MAP,
}

/**
 * Maps one row's raw platform status to a stable status key.
 *
 * Returns null for a status no map knows about, so the caller can fall back to
 * showing the platform's raw string rather than mislabelling the order — the
 * same principle getOrderTab()'s OTHER_TAB fallback applies to tab routing.
 *
 * @param platform lowercase platform slug as stored in the row ('shopee', ...)
 * @param rawStatus the platform's own status value, stored verbatim by the
 *   sync jobs (see api/_lib/shopeeSync.js and friends)
 */
export function statusKeyFor(platform, rawStatus) {
  return RAW_STATUS_MAP_BY_PLATFORM[platform]?.[rawStatus] ?? null
}
