import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Check, Copy, Loader2, Package, Printer, RefreshCw, ScanLine, Search, Truck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import PrintAwbConfirmDialog from '@/components/PrintAwbConfirmDialog'
import PrintAwbMarkPrintedDialog from '@/components/PrintAwbMarkPrintedDialog'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'
import { getAutoSyncOrdersEnabled } from '@/lib/preferences'
import { apiUrl, describeRequestError } from '@/lib/apiBase'
import {
  deliverPdf,
  describeFailedOrders,
  downloadAwbResponse,
  logPrintAwbFailure,
  printAwbErrorMessage,
} from '@/lib/awb'
import {
  confirmPendingAwbPrint,
  dismissPendingAwbPrint,
  finalizeAwbDelivery,
  usePendingAwbPrint,
} from '@/lib/awbPrintPrompt'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { useDateTime } from '@/lib/i18n/datetime'
import { STATUS, statusKeyFor } from '@/lib/orderStatus'

const AUTO_SYNC_INTERVAL_MS = 60_000

// sync-orders.js reports per-store failures as `errors: [{ storeId, error }]`
// (not a single `error` string) whenever at least one store fails. Surfacing
// `data.error` alone — what most other endpoints use — would silently miss
// this shape and fall through to a generic message.
function describeSyncError(data) {
  if (data?.error) return data.error
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    return data.errors.map((e) => e.error).filter(Boolean).join('; ') || null
  }
  return null
}

const PLATFORM_META = {
  Shopee: {
    badge: 'bg-orange-500/15 text-orange-600',
    chipActive: 'bg-orange-500/15 text-orange-600',
    tint: 'bg-orange-500/10',
  },
  Lazada: {
    badge: 'bg-blue-500/15 text-blue-600',
    chipActive: 'bg-blue-500/15 text-blue-600',
    tint: 'bg-blue-500/10',
  },
  TikTok: {
    badge: 'bg-gray-500/15 text-gray-600',
    chipActive: 'bg-gray-500/15 text-gray-600',
    tint: 'bg-gray-400/15',
  },
  Shopify: {
    badge: 'bg-green-500/15 text-green-600',
    chipActive: 'bg-green-500/15 text-green-600',
    tint: 'bg-green-500/10',
  },
}

// Shared pill style for the small informational flags on an order card
// (Waiting for payment / Printed / Auto-pack failed / Auto-packed) — one
// consistent size/weight regardless of which flag is showing.
const BADGE_CLS = 'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none'

// Shared tap-target size for card/sheet action buttons (Pack, Cancel, Print
// AWB, Track) — bigger than the base shadcn "sm" size for comfortable mobile
// tapping, kept consistent across every action so none feel like an outlier.
const ACTION_BTN_CLS = 'h-9 rounded-lg px-3 text-[13px] font-medium'

// Filter values are STABLE KEYS, never display labels — the same fix Products
// needed. `printedFilter === 'Printed'` and `platformFilter !== 'All'` were
// comparisons against on-screen English: the first translated label would have
// made the platform chips filter nothing and the printed chips invert.
//
// Brand names double as their own keys (they are also the values in
// order.platform, and read the same in both locales); only ALL_FILTER is
// chrome, so it is the one platform entry that gets translated.
const ALL_FILTER = 'all'

const PLATFORM_FILTERS = [ALL_FILTER, 'Shopee', 'Lazada', 'TikTok', 'Shopify']

const PRINTED_FILTERS = [ALL_FILTER, 'notPrinted', 'printed']

// The tab holding "Packed" orders — the ones already shipped-out via
// ship_order and now waiting on an AWB label (plus RETRY_SHIP: a shipment
// was arranged but the attempt failed and needs another try). READY_TO_SHIP
// ("To Pack") lives in the "new" tab instead — it needs Pack, not a label.
const TO_PACK_TAB = 'inprocess'

// Catch-all tab for any Shopee order_status we don't have a mapping for yet.
// An order must never silently disappear from every tab just because Shopee
// added/returned a status this app doesn't know about — see getOrderTab().
const OTHER_TAB = 'other'

// 'To Pack' (READY_TO_SHIP) buckets into the "New Orders" tab — that's the
// point where the seller actually needs to act (call ship_order).
// 'Unpaid' (UNPAID) gets its own tab: it can never be packed until Shopee
// itself flips the order to READY_TO_SHIP once the buyer pays.
// 'To Confirm Receipt' (courier has it, buyer hasn't confirmed) buckets into
// Shipped — from the seller's point of view there's nothing left to do.
// 'Cancel Requested' (IN_CANCEL, a BUYER-initiated cancellation awaiting the
// seller) gets its OWN tab — NOT Cancelled. It's a live, refund-bearing,
// time-sensitive decision (Shopee auto-accepts after ~2 days of no response),
// exactly the same reasoning as 'Return Requested' below. Folding it into
// Cancelled (implicitly "done, nothing to do") is precisely how these requests
// went unanswered before.
// 'Return Requested' (TO_RETURN) gets its own tab, not Cancelled: unlike a
// cancellation, a return is often time-sensitive and requires the seller to
// accept/dispute it — folding it into Cancelled (a tab whose implicit
// meaning is "done, nothing to do") risks a seller missing the deadline.
// 'Returned' shares that tab but is the OPPOSITE end of the same lifecycle:
// the return is finished and the goods are physically back. It exists as a
// separate label rather than reusing 'Return Requested' because the two must
// stay tellable apart inside the Returns tab — one still needs a decision, the
// other is a stock/refund reconciliation. Only Lazada reaches it today (Shopee
// exposes no post-return status; see LAZADA_STATUS_MAP in lib/orderStatus.js).
//
// STATUS (the canonical keys) and the three raw->key platform maps now live in
// src/lib/orderStatus.js — Scan and Dashboard need the same vocabulary, and
// keeping a second copy here is what the note above warns against. The tab
// bucketing below is Orders' own concern and stays here.

// STATUS_LABEL is gone: all twelve labels now live in the shared `status:`
// dictionary namespace and are resolved HERE, at render, never stored.
//
// Resolving late is the same discipline the date fields already follow (see
// the note on orderedAt in mapSupabaseOrder): a label baked into the mapper
// would be pinned to whichever locale was active during the fetch, so
// switching language would leave stale English statuses on screen until the
// next refetch.
//
// An unmapped status has no key, so its raw platform string is shown verbatim
// — data passthrough, the same treatment it gets in getOrderTab's OTHER_TAB.
function statusLabel(t, order) {
  return order.statusKey ? t(`status.${order.statusKey}`) : order.rawStatus
}

const STATUS_TO_TAB = {
  [STATUS.UNPAID]: 'unpaid',
  [STATUS.INVOICE_PENDING]: 'new',
  [STATUS.TO_PACK]: 'new',
  [STATUS.PACKED]: 'inprocess',
  [STATUS.RETRY_SHIPMENT]: 'inprocess',
  [STATUS.SHIPPED]: 'shipped',
  [STATUS.TO_CONFIRM_RECEIPT]: 'shipped',
  [STATUS.COMPLETED]: 'completed',
  [STATUS.CANCEL_REQUESTED]: 'cancelRequests',
  [STATUS.RETURN_REQUESTED]: 'returns',
  [STATUS.RETURNED]: 'returns',
  [STATUS.CANCELLED]: 'cancelled',
}

// Defensive lookup — always resolves to a real, visible tab, even for a
// status this app has never seen before (statusKey null, see mapSupabaseOrder).
function getOrderTab(order) {
  return (order.statusKey ? STATUS_TO_TAB[order.statusKey] : undefined) ?? OTHER_TAB
}

const STATUS_BADGE = {
  [STATUS.UNPAID]: 'bg-gray-200 text-gray-600',
  [STATUS.INVOICE_PENDING]: 'bg-orange-500/15 text-orange-600',
  [STATUS.TO_PACK]: 'bg-yellow-600/15 text-yellow-700',
  [STATUS.PACKED]: 'bg-yellow-600/15 text-yellow-700',
  [STATUS.RETRY_SHIPMENT]: 'bg-orange-600/15 text-orange-700',
  [STATUS.SHIPPED]: 'bg-green-500/15 text-green-600',
  [STATUS.TO_CONFIRM_RECEIPT]: 'bg-green-500/15 text-green-600',
  [STATUS.COMPLETED]: 'bg-teal-500/15 text-teal-600',
  [STATUS.CANCEL_REQUESTED]: 'bg-amber-500/15 text-amber-700',
  [STATUS.RETURN_REQUESTED]: 'bg-amber-500/15 text-amber-700',
  // Same amber family as 'Return Requested' (they share the Returns tab), one
  // step deeper because this one is terminal — nothing is pending on it.
  [STATUS.RETURNED]: 'bg-amber-600/15 text-amber-800',
  [STATUS.CANCELLED]: 'bg-red-500/15 text-red-600',
}

const DEFAULT_STATUS_BADGE = 'bg-gray-200 text-gray-600'

// This column shows each MARKETPLACE's own wording for a status, not the
// app's — that is its whole purpose, so it is mostly platform DATA rather than
// chrome and is NOT uniformly translated.
//
// Shopee is the exception: the seller works in Shopee Seller Centre, which has
// its own zh-CN vocabulary, so Shopee's row goes through t() and reads in
// Seller Centre's Chinese. Its values below are dictionary KEYS, not text.
//
// Lazada, TikTok and Shopify stay as literal English: that is the wording
// those consoles actually show, and there is no verified Chinese for them.
// Inventing one would misreport what the seller will see on that platform.
const MARKETPLACE_STATUS_SHOPEE_KEYS = {
  [STATUS.UNPAID]: 'unpaid',
  [STATUS.INVOICE_PENDING]: 'invoicePending',
  [STATUS.TO_PACK]: 'processed',
  [STATUS.PACKED]: 'processed',
  [STATUS.RETRY_SHIPMENT]: 'retryShipment',
  [STATUS.SHIPPED]: 'shipped',
  [STATUS.TO_CONFIRM_RECEIPT]: 'toConfirmReceive',
  [STATUS.CANCEL_REQUESTED]: 'cancellationRequested',
  [STATUS.RETURN_REQUESTED]: 'toReturnRefund',
  [STATUS.CANCELLED]: 'cancelled',
}

const MARKETPLACE_STATUS = {
  // Corrected against LAZADA_STATUS_MAP below and live Lazada data. The old
  // values here were a placeholder written before Lazada was connected and were
  // simply wrong — they claimed Lazada's word for canonical Unpaid was
  // "Pending", when Lazada's `pending` actually means paid-and-awaiting-pack
  // (canonical 'To Pack'), and its `unpaid` is the awaiting-payment state.
  //
  // Keyed on the canonical label, so where LAZADA_STATUS_MAP is many-to-one
  // this names only one of the collapsed statuses — the same lossiness Shopee
  // has ('To Pack' and 'Packed' both showing "Processed"). Here that means a
  // `ready_to_ship` order reads "Ready to Ship", and a `returned`/`failed` one
  // reads "Canceled".
  //
  // A `confirmed` order now reads "Delivered" (it maps to canonical 'Completed'
  // — see LAZADA_STATUS_MAP below for why). That is the least-bad wording: the
  // order IS settled, and Seller Centre's own word for the state is not exposed
  // in any list this app can see.
  //
  // "Canceled" is spelled with one 'l' on purpose: that is Lazada's own
  // spelling, and this table shows the marketplace's wording, not the app's.
  Lazada: {
    [STATUS.UNPAID]: 'Unpaid',
    [STATUS.TO_PACK]: 'Pending',
    [STATUS.PACKED]: 'Ready to Ship',
    [STATUS.SHIPPED]: 'Shipped',
    [STATUS.COMPLETED]: 'Delivered',
    // Collapses returned / shipped_back / shipped_back_success /
    // package_returned, so this names only the representative — the same
    // lossiness 'To Pack' and 'Packed' already have here.
    [STATUS.RETURNED]: 'Returned',
    [STATUS.CANCELLED]: 'Canceled',
  },
  // Audited against TIKTOK_STATUS_MAP / TikTok Shop's documented order_status
  // enum and Seller Center's own status vocabulary — replaces the earlier
  // placeholder guess (the previous values here were never checked against
  // TikTok's real vocabulary at all). Still not verified against a live
  // sandbox order — confirm before relying on it for real decisions.
  //
  // Keyed on the canonical label, so where TIKTOK_STATUS_MAP is many-to-one
  // this can only name one of the collapsed statuses — the same lossiness
  // Shopee already has ('To Pack' and 'Packed' both showing "Processed").
  // Here that means an ON_HOLD order reads "Unpaid" and an AWAITING_COLLECTION
  // one reads "Awaiting Collection" even if it was PARTIALLY_SHIPPING. There
  // is deliberately no 'Invoice Pending' entry: no TikTok status maps to that
  // label any more, so one here would be dead.
  TikTok: {
    [STATUS.UNPAID]: 'Unpaid',
    [STATUS.TO_PACK]: 'Awaiting Shipment',
    [STATUS.PACKED]: 'Awaiting Collection',
    [STATUS.SHIPPED]: 'In Transit',
    [STATUS.TO_CONFIRM_RECEIPT]: 'Delivered',
    [STATUS.COMPLETED]: 'Completed',
    [STATUS.CANCELLED]: 'Cancelled',
  },
  // Shopify isn't connected yet — this is still an unverified placeholder, and
  // there is no shopify entry in RAW_STATUS_MAP_BY_PLATFORM to feed it. It is
  // the last remaining table in this file of the kind Lazada and TikTok have
  // both now been corrected out of.
  Shopify: {
    [STATUS.UNPAID]: 'Unfulfilled',
    [STATUS.TO_PACK]: 'Unfulfilled',
    [STATUS.PACKED]: 'Unfulfilled',
    [STATUS.SHIPPED]: 'Fulfilled',
    [STATUS.CANCELLED]: 'Cancelled',
  },
}

// Falls back to the app's own label (or, for an unmapped status, the raw
// platform string) when this marketplace has no wording of its own for the
// state — unchanged behaviour, just keyed off statusKey now.
function getMarketplaceStatus(t, order) {
  if (!order.statusKey) return statusLabel(t, order)

  if (order.platform === 'Shopee') {
    const key = MARKETPLACE_STATUS_SHOPEE_KEYS[order.statusKey]
    return key ? t(`orders.marketplaceStatus.shopee.${key}`) : statusLabel(t, order)
  }

  // Every other platform's own English wording, verbatim.
  return MARKETPLACE_STATUS[order.platform]?.[order.statusKey] ?? statusLabel(t, order)
}

// `key` is the stable tab id — it is the URL's ?tab= value, the key of
// STATUS_TO_TAB and of tabCounts, and what getInitialTab validates. The label
// is looked up from it at render, so tab wording can change freely.
const TABS = [
  { key: 'unpaid', badgeClass: 'bg-gray-200 text-gray-600' },
  { key: 'new', badgeClass: 'bg-red-500 text-white' },
  { key: 'inprocess', badgeClass: 'bg-yellow-500 text-gray-900' },
  { key: 'shipped', badgeClass: 'bg-[#2563EB] text-white' },
  { key: 'completed' },
  // Buyer-initiated cancellations awaiting the seller's approve/reject. Red
  // badge (like New Orders) because it's time-sensitive: Shopee auto-accepts
  // after ~2 days of no response.
  { key: 'cancelRequests', badgeClass: 'bg-red-500 text-white' },
  { key: 'returns', badgeClass: 'bg-amber-500 text-white' },
  { key: 'cancelled' },
  // Safety net only — should stay at 0 in normal operation. A non-zero count
  // here means Shopee returned a status SHOPEE_STATUS_MAP doesn't know about
  // yet (check the console for a "[orders] unmapped Shopee order_status" warning).
  { key: 'other', badgeClass: 'bg-gray-400 text-white' },
]

const TAB_KEYS = new Set(TABS.map((tab) => tab.key))

// Hard ceiling on the paged order fetch. Generous enough that it should never
// trip in practice (~20 pages), but it exists so "too many orders to load" is a
// LOUD, visible state rather than a silent short list — the failure mode that
// PostgREST's 1000-row cap produced for free.
const ORDERS_CEILING = 20_000
const DEFAULT_TAB = 'new'

// A mobile pull-to-refresh is a full page reload, which wipes React state —
// reading the tab from the URL on mount (rather than always defaulting to
// DEFAULT_TAB) is what makes the active tab survive that reload. Falls back
// to the default for a missing/stale/hand-edited ?tab= value instead of
// trusting it blindly.
function getInitialTab(searchParams) {
  const fromUrl = searchParams.get('tab')
  return TAB_KEYS.has(fromUrl) ? fromUrl : DEFAULT_TAB
}

const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
}


// shipping_method is whichever of pickup/dropoff/non_integrated Shopee's
// info_needed selected when ship_order fired (see api/_lib/shopeeShip.js).
// The raw values are the stable keys; an unrecognised one falls through to
// Shopee's own string rather than being mislabelled.
const SHIPPING_METHODS = ['pickup', 'dropoff', 'non_integrated']

function shippingMethodLabel(t, method) {
  return SHIPPING_METHODS.includes(method) ? t(`orders.shippingMethod.${method}`) : method
}

function awbFilename(orderSnList) {
  return orderSnList.length === 1
    ? `AWB-${orderSnList[0]}.pdf`
    : `AWB-${orderSnList.length}-orders.pdf`
}

async function postOrderAction(session, order, action) {
  const res = await fetch(apiUrl('/api/shopee/order-action'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      store_id: order.store_id,
      order_sn: order.platform_order_id,
      action,
    }),
  })
  const data = await res.json().catch(() => ({}))

  if (!res.ok || !data.success) {
    // Shopee's real reason lives in the full body; keep it in the console.
    console.log(
      `[order-action] ${action} ${order.platform_order_id} failed at step "${data.step ?? 'unknown'}"`,
      '\nerror:',
      data.error,
      '\nfull response:',
      JSON.stringify(data, null, 2)
    )
  }

  return { ok: res.ok && data.success, error: data.error, data }
}


function mapSupabaseOrder(row, storeNames) {
  const platform = PLATFORM_LABELS[row.platform] ?? row.platform
  const mappedStatusKey = statusKeyFor(row.platform, row.order_status)

  // Never let an unrecognized status make the order vanish: fall back to the
  // raw value (still routed somewhere visible via getOrderTab's OTHER_TAB
  // fallback) and flag it loudly so the relevant map gets updated.
  if (row.order_status && !mappedStatusKey) {
    console.warn(
      `[orders] unmapped ${platform} order_status "${row.order_status}" for order ${row.platform_order_id} — showing under "Other" until the status map for this platform is updated.`
    )
  }

  // Three cases, preserved exactly from when `status` was the only field:
  //   mapped              -> statusKey set, label resolved by statusLabel()
  //   unmapped but present-> statusKey null, raw platform string shown verbatim
  //                          (Other tab, default badge) — data passthrough, the
  //                          same treatment an unknown status gets everywhere
  //   null/undefined      -> treated as Unpaid, where a row with no status has
  //                          always bucketed
  //
  // The null check is deliberately nullish, not truthy: this replaced
  // `mappedStatus ?? row.order_status ?? 'Unpaid'`, and under `??` an empty-string
  // order_status passed through as an empty string rather than becoming Unpaid.
  // Treating '' as absent here would move such a row from the Other tab into
  // Unpaid and give it a badge it never had.
  const statusKey = mappedStatusKey ?? (row.order_status == null ? STATUS.UNPAID : null)
  const storeName = storeNames?.[row.store_id] ?? ''

  // Item names are Shopee DATA. A missing one stays null so the placeholder
  // can be resolved at render, where the locale is known.
  const items = (row.order_items ?? []).map((item) => ({
    name: item.product_name || null,
    qty: item.quantity ?? 1,
    price: Number(item.price) || 0,
    variant: item.variant_name || undefined,
    image: item.image_url || null,
  }))

  return {
    id: `#${row.platform_order_id}`,
    store_id: row.store_id,
    storeName,
    platform_order_id: row.platform_order_id,
    platform,
    buyer: row.buyer_name || null,
    phone: row.buyer_phone || '-',
    address: row.shipping_address || '-',
    region: row.region || '-',
    items:
      items.length > 0
        ? items
        : [{ name: null, qty: 1, price: Number(row.total_amount) || 0, image: null }],
    total: Number(row.total_amount) || 0,
    payment: row.payment_method || '-',
    // statusKey drives every decision (tab, badge, button guards). No display
    // label is stored at all any more — statusLabel(t, order) resolves it at
    // render, so a language switch updates every status on screen immediately.
    // rawStatus is kept only as the fallback for a status with no key.
    statusKey,
    rawStatus: row.order_status ?? null,
    // Raw timestamps, formatted at render by useDateTime() rather than here.
    // Pre-formatting them in this mapper would have pinned every date to
    // whichever locale was active during the fetch, so switching language
    // would have left stale dates on screen until the next refetch.
    orderedAt: row.order_created_at || null,
    paidAt: row.paid_at || null,
    packedAt: row.packed_at || null,
    packedBy: row.packed_by || undefined,
    // A 'failed'/'skipped' auto-pack never retries (see api/_lib/autoPack.js)
    // — the order just sits at READY_TO_SHIP forever unless a human notices,
    // so this has to be visible in the list, not just queryable in the DB.
    autoPackStatus: row.auto_pack_status || undefined,
    autoPackError: row.auto_pack_error || undefined,
    courier: row.courier_name || undefined,
    shippingMethod: row.shipping_method || undefined,
    trackingNumber: row.tracking_number || undefined,
    // Buyer-cancellation decision context (populated on IN_CANCEL orders).
    // buyerCancelReason is the free-text/enum reason the seller reads before
    // approving or rejecting; cancelBy confirms it was buyer-initiated.
    buyerCancelReason: row.buyer_cancel_reason || undefined,
    cancelReason: row.cancel_reason || undefined,
    cancelBy: row.cancel_by || undefined,
    // Buyer's own checkout note. Auto-pack skips any order with one (see
    // api/_lib/autoPack.js) — surfaced prominently here since it's the reason
    // a human needs to pack the order instead.
    buyerMessage: row.buyer_message || undefined,
    awbPrinted: row.awb_printed === true,
    awbPrintedAt: row.awb_printed_at || null,
  }
}

// Item thumbnail: real image when available, otherwise a neutral placeholder.
function ItemThumb({ image, alt, tint, className }) {
  if (image) {
    return (
      <img
        src={image}
        alt={alt}
        className={cn('shrink-0 rounded-lg object-cover', className)}
      />
    )
  }
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        tint,
        className
      )}
    >
      <Package className="h-4 w-4 text-gray-400" />
    </div>
  )
}

// `t` is threaded in rather than read from a hook: this is a plain function,
// not a component, and it is also called in a boolean position (`renderActions(...) &&`)
// where a hook would be illegal.
function renderActions(t, order, { fullWidth = false, onPrintAWB, printingId, onPack, onCancel, onBuyerCancel, actingId } = {}) {
  // TikTok and Lazada orders are read-only for now: Pack/Cancel/Approve/
  // Reject all go through postOrderAction -> POST /api/shopee/order-action,
  // and Print AWB goes through /api/shopee/print-awb — both Shopee-only
  // endpoints that don't know about TikTok/Lazada shops or tokens at all.
  // order.platform is the display label set in mapSupabaseOrder
  // (PLATFORM_LABELS), so this compares against 'TikTok'/'Lazada', not the
  // raw 'tiktok'/'lazada' platform column values.
  if (order.platform === 'TikTok' || order.platform === 'Lazada') {
    return null
  }

  const tab = getOrderTab(order)
  const grow = fullWidth ? 'flex-1' : ''
  const printing = printingId === order.id
  const acting = actingId === order.id

  const printAwbButton = (className) => (
    <Button
      size="sm"
      disabled={printing}
      onClick={(e) => {
        e.stopPropagation()
        onPrintAWB?.(order)
      }}
      className={cn(ACTION_BTN_CLS, grow, className)}
    >
      {printing ? <Loader2 className="animate-spin" /> : <Printer />} {t('orders.actions.printAwb')}
    </Button>
  )

  const cancelButton = (
    <Button
      size="sm"
      variant="ghost"
      disabled={acting}
      onClick={(e) => {
        e.stopPropagation()
        onCancel?.(order)
      }}
      className={cn(ACTION_BTN_CLS, grow, 'text-red-600 hover:bg-red-500/10 hover:text-red-600')}
    >
      {acting ? <Loader2 className="animate-spin" /> : null} {t('orders.actions.cancel')}
    </Button>
  )

  // Approve / Reject a buyer's cancellation request. Deliberately styled
  // IDENTICALLY — same neutral outline, same weight, no primary/coloured
  // "recommended" affordance on either — so neither reads as the safe default.
  // The seller must read the buyer's reason and choose each time.
  if (tab === 'cancelRequests') {
    const buyerCancelButton = (decision, labelText) => (
      <Button
        size="sm"
        variant="outline"
        disabled={acting}
        onClick={(e) => {
          e.stopPropagation()
          onBuyerCancel?.(order, decision)
        }}
        className={cn(ACTION_BTN_CLS, grow, 'border-[#E8E6E1] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]')}
      >
        {acting ? <Loader2 className="animate-spin" /> : null} {labelText}
      </Button>
    )
    return (
      <>
        {buyerCancelButton('accept', t('orders.actions.approve'))}
        {buyerCancelButton('reject', t('orders.actions.reject'))}
      </>
    )
  }

  if (tab === 'unpaid') {
    return <>{cancelButton}</>
  }

  if (tab === 'new') {
    return (
      <>
        {/* Pack calls ship_order, which Shopee only accepts for READY_TO_SHIP
            ("To Pack"). Every order in this tab should already be that status,
            but this guard keeps the button honest if that ever changes. */}
        {order.statusKey === STATUS.TO_PACK && (
          <Button
            size="sm"
            disabled={acting}
            onClick={(e) => {
              e.stopPropagation()
              onPack?.(order)
            }}
            className={cn(ACTION_BTN_CLS, grow, 'bg-[#2563EB] text-white hover:bg-[#2563EB]/90')}
          >
            {acting ? <Loader2 className="animate-spin" /> : <Package />} {t('orders.actions.pack')}
          </Button>
        )}
        {cancelButton}
      </>
    )
  }

  if (tab === 'inprocess') {
    return (
      <>
        {printAwbButton('bg-[#2563EB] text-white hover:bg-[#2563EB]/90')}
        {cancelButton}
      </>
    )
  }

  if (tab === 'shipped') {
    return (
      <>
        {printAwbButton('bg-gray-200 text-[#1F2937] hover:bg-gray-300')}
        <Button size="sm" variant="ghost" className={cn(ACTION_BTN_CLS, grow, 'text-[#374151]')}>
          {t('orders.actions.track')}
        </Button>
      </>
    )
  }

  return null
}

// How far along the Ordered -> Packed -> Shipped rail each status sits.
// Keyed by status key, so the rail can't silently collapse to stage 0 for
// every order the moment a status label is reworded.
const TIMELINE_STAGE = {
  [STATUS.UNPAID]: 0,
  [STATUS.INVOICE_PENDING]: 0,
  [STATUS.TO_PACK]: 1,
  [STATUS.PACKED]: 1,
  [STATUS.RETRY_SHIPMENT]: 1,
  [STATUS.SHIPPED]: 2,
  [STATUS.TO_CONFIRM_RECEIPT]: 2,
  [STATUS.COMPLETED]: 2,
  [STATUS.RETURN_REQUESTED]: 2,
}

// Stable stage keys — also used as the React key below, so a translated label
// can never change list identity.
const TIMELINE_STAGES = ['ordered', 'packed', 'shipped']

function OrderTimeline({ statusKey, statusLabel }) {
  const { t } = useTranslation()

  if (statusKey === STATUS.CANCELLED) {
    return (
      <div className="flex items-center">
        <div className="flex flex-col items-center gap-1">
          <span className="h-3 w-3 rounded-full bg-[#2563EB]" />
          <span className="text-xs text-[#1F2937]">{t('orders.timeline.ordered')}</span>
        </div>
        <span className="mx-1 h-0.5 flex-1 bg-red-500/50" />
        <div className="flex flex-col items-center gap-1">
          <span className="h-3 w-3 rounded-full bg-red-500" />
          <span className="text-xs text-red-600">{statusLabel}</span>
        </div>
      </div>
    )
  }

  const stageIndex = (statusKey ? TIMELINE_STAGE[statusKey] : undefined) ?? 0

  return (
    <div className="flex items-center">
      {TIMELINE_STAGES.map((stage, i) => (
        <Fragment key={stage}>
          <div className="flex flex-col items-center gap-1">
            <span
              className={cn(
                'h-3 w-3 rounded-full',
                i <= stageIndex ? 'bg-[#2563EB]' : 'bg-gray-300'
              )}
            />
            <span className={cn('text-xs', i <= stageIndex ? 'text-[#1F2937]' : 'text-gray-400')}>
              {t(`orders.timeline.${stage}`)}
            </span>
          </div>
          {i < TIMELINE_STAGES.length - 1 && (
            <span
              className={cn('mx-1 h-0.5 flex-1', i < stageIndex ? 'bg-[#2563EB]' : 'bg-gray-300')}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

function CopyButton({ text }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      aria-label={t('orders.copyTracking')}
      className="text-gray-400 hover:text-gray-600"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

// Item and variant names are Shopee DATA and are joined verbatim; only the
// placeholder for a nameless item comes from the dictionary.
function itemsSummary(t, items) {
  return items
    .map((item) => {
      const name = item.name ?? t('orders.unnamedItem')
      return item.variant ? `${name} (${item.variant}) x${item.qty}` : `${name} x${item.qty}`
    })
    .join(', ')
}

function OrderCard({
  order,
  onClick,
  selectionMode,
  selected,
  onPrintAWB,
  printingId,
  onPack,
  onCancel,
  onBuyerCancel,
  actingId,
}) {
  const { t } = useTranslation()
  const { formatDateTime, formatRelativeToNow } = useDateTime()
  const meta = PLATFORM_META[order.platform]
  const actions = !selectionMode
    ? renderActions(t, order, { fullWidth: true, onPrintAWB, printingId, onPack, onCancel, onBuyerCancel, actingId })
    : null

  const flagBadges = [
    order.buyerMessage && (
      <span key="buyer-message" className={cn(BADGE_CLS, 'bg-blue-500/15 text-blue-700')}>
        {t('orders.buyerMessage.badge')}
      </span>
    ),
    order.statusKey === STATUS.UNPAID && (
      <span key="unpaid" className={cn(BADGE_CLS, 'bg-gray-200 text-gray-600')}>
        {t('orders.flags.waitingForPayment')}
      </span>
    ),
    order.awbPrinted && (
      <span
        key="printed"
        title={
          order.awbPrintedAt
            ? t('orders.flags.printedAt', { date: formatDateTime(order.awbPrintedAt) })
            : undefined
        }
        className={cn(BADGE_CLS, 'bg-green-500/15 text-green-700')}
      >
        🖨️ {t('orders.flags.printed')}
      </span>
    ),
    // auto_pack_status never retries once set (see api/_lib/autoPack.js) — a
    // 'failed' order just sits at READY_TO_SHIP forever unless someone
    // notices and packs it manually, so this has to be loud.
    order.autoPackStatus === 'failed' && (
      <span
        key="autopack-failed"
        // autoPackError is the server's own reason — shown verbatim when set.
        title={order.autoPackError || t('orders.flags.autoPackFailedHint')}
        className={cn(BADGE_CLS, 'bg-red-500/15 text-red-700')}
      >
        ⚠️ {t('orders.flags.autoPackFailed')}
      </span>
    ),
    order.packedBy === 'auto' && (
      <span key="auto-packed" className={cn(BADGE_CLS, 'bg-blue-500/15 text-blue-700')}>
        ⚡ {t('orders.flags.autoPacked')}
      </span>
    ),
  ].filter(Boolean)

  return (
    <div
      onClick={() => onClick(order)}
      className="flex cursor-pointer gap-3 rounded-2xl border border-[#E8E6E1] bg-white p-4 shadow-card transition-transform active:scale-[0.98]"
    >
      {selectionMode && order.statusKey !== STATUS.UNPAID && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onClick(order)}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 bg-white accent-[#2563EB]"
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-[#6B7280]">
          <span className={cn('rounded-full px-2 py-0.5 font-medium', meta.badge)}>
            {order.platform}
          </span>
          {order.storeName && <span className="truncate">{order.storeName}</span>}
          <span className="ml-auto shrink-0 font-mono tabular-nums text-gray-500">{order.id}</span>
          <span className="shrink-0 tabular-nums text-gray-400">
            {formatRelativeToNow(order.orderedAt)}
          </span>
        </div>

        <div className="mt-2.5">
          {/* Buyer name/phone/region are Shopee DATA — untouched. */}
          <p className="text-base leading-tight font-semibold text-[#1F2937]">
            {order.buyer ?? t('orders.unknownBuyer')}
          </p>
          <p className="mt-0.5 text-xs text-[#6B7280]">{order.phone}</p>
          <p className="text-xs text-[#9CA3AF]">{order.region}</p>
        </div>

        {flagBadges.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">{flagBadges}</div>
        )}

        {order.statusKey === STATUS.CANCEL_REQUESTED && (
          <div className="mt-2.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-800">
            <p className="font-semibold">{t('orders.cancelRequest.title')}</p>
            <p className="mt-0.5">
              {t('orders.cancelRequest.reason')}:{' '}
              {order.buyerCancelReason || order.cancelReason || t('orders.cancelRequest.notProvided')}
            </p>
            <p className="mt-0.5 text-amber-700">{t('orders.cancelRequest.deadlineShort')}</p>
          </div>
        )}

        {order.buyerMessage && (
          <div className="mt-2.5 rounded-lg bg-blue-500/10 px-2.5 py-2 text-[11px] leading-snug text-blue-800">
            <p className="font-semibold">{t('orders.buyerMessage.title')}</p>
            <p className="mt-0.5 whitespace-pre-wrap">{order.buyerMessage}</p>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2.5">
          {order.items.slice(0, 3).map((item, i) => (
            <ItemThumb
              key={i}
              image={item.image}
              alt={item.name ?? t('orders.unnamedItem')}
              tint={meta.tint}
              className="h-10 w-10"
            />
          ))}
          <p className="truncate text-xs leading-snug text-[#6B7280]">{itemsSummary(t, order.items)}</p>
        </div>

        {order.courier && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[#F3F4F6] px-2 py-1 text-[11px] text-[#6B7280]">
              {order.platform}-MY-{order.courier}
            </span>
            {order.shippingMethod && (
              <span className="rounded-md bg-[#F3F4F6] px-2 py-1 text-[11px] text-[#6B7280]">
                {t('orders.arrangedVia')}: {shippingMethodLabel(t, order.shippingMethod)}
              </span>
            )}
            {order.trackingNumber && (
              <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-[#6B7280]">
                {order.trackingNumber}
                <CopyButton text={order.trackingNumber} />
              </span>
            )}
          </div>
        )}

        {(order.paidAt || order.packedAt) && (
          <div className="mt-2 flex gap-4 text-[11px] tabular-nums text-gray-500">
            {order.paidAt && <span>{t('orders.paidAt', { date: formatDateTime(order.paidAt) })}</span>}
            {order.packedAt && (
              <span>{t('orders.packedAt', { date: formatDateTime(order.packedAt) })}</span>
            )}
          </div>
        )}

        <div className="mt-3.5 border-t border-[#F1F0EC] pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-base font-semibold tabular-nums text-[#1F2937]">
              RM {order.total.toFixed(2)}
            </span>
            <span className="truncate rounded-full bg-[#F3F4F6] px-2.5 py-1 text-[11px] font-medium text-[#374151]">
              {order.payment}
            </span>
          </div>
          {actions && (
            <div className="mt-2.5 flex gap-2" onClick={(e) => e.stopPropagation()}>
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Orders() {
  const { t } = useTranslation()
  const { formatDateTime, formatShortAgo } = useDateTime()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeTab, setActiveTabState] = useState(() => getInitialTab(searchParams))
  const [platformFilter, setPlatformFilter] = useState(ALL_FILTER)
  const [search, setSearch] = useState('')
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [orders, setOrders] = useState([])
  // True only when the paged fetch hit ORDERS_CEILING, i.e. the list on screen
  // really is incomplete. Surfaced to the user — never silently swallowed.
  const [ordersTruncated, setOrdersTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [printingId, setPrintingId] = useState(null)
  const [bulkPrinting, setBulkPrinting] = useState(false)
  const [printConfirm, setPrintConfirm] = useState(null) // { count, run } | null
  const pendingAwbPrint = usePendingAwbPrint()
  const [printedFilter, setPrintedFilter] = useState(ALL_FILTER)
  const [actingId, setActingId] = useState(null)
  const [bulkActing, setBulkActing] = useState(null)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)
  const [nowTick, setNowTick] = useState(null)
  // True when the last sync ran out of its time budget before finishing the
  // full window (e.g. a store with a large backlog). Persists across renders
  // — unlike a toast, which auto-sync's silent-on-success mode would never
  // show at all — until a subsequent sync (manual or auto) finishes clean.
  const [hasMorePending, setHasMorePending] = useState(false)

  // Auto-sync coordination — refs so the 60s interval (set up once) always
  // sees the latest values without needing to be torn down/recreated on
  // every render.
  const syncInFlightRef = useRef(false)
  const autoSyncErrorShownRef = useRef(false)
  const selectionModeRef = useRef(selectionMode)
  // Whether this account has at least one connected Shopee store. Defaults to
  // true (fail open) so the very first render — before fetchOrders' stores
  // query has resolved — doesn't skip a legitimate sync. performSync reads
  // this via a ref (not state) since it's a useCallback with an empty dep
  // array, same convention as the other auto-sync refs above.
  const hasShopeeStoreRef = useRef(true)

  useEffect(() => {
    selectionModeRef.current = selectionMode
  }, [selectionMode])

  // replace (not the default push) so switching tabs never adds a history
  // entry — otherwise every tab tap would need its own Back press to undo.
  const setActiveTab = useCallback(
    (tab) => {
      setActiveTabState(tab)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('tab', tab)
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    // PAGED to completeness rather than one unbounded select, which silently
    // stopped at PostgREST's 1000-row cap and hid 244 real orders — invisible
    // to search, tabs and filters alike, because all three run client-side over
    // this array.
    //
    // Paging (not a bigger .limit()) because a bigger number is the same bug
    // with a later fuse. This page genuinely needs every row: the tab counts,
    // the platform counts and "Print All" are all computed across the whole
    // set, so a windowed or server-filtered fetch would silently wrong those
    // counts instead — a worse failure than a slow load.
    //
    // ORDERS_CEILING bounds the worst case. Past it the list IS incomplete, and
    // that is surfaced in the UI (see the banner below) rather than being
    // swallowed the way the 1000-row cap was. If this ever trips in practice,
    // the real fix is server-side filtering with server-computed tab counts —
    // a rewrite of this page's data model, not another number bump.
    const [ordersRes, storesRes] = await Promise.all([
      selectAllPaged(
        'orders.list',
        (from, to) =>
          supabase
            .from('orders')
            .select('*, order_items(*)')
            .order('order_created_at', { ascending: false })
            .range(from, to),
        { maxRows: ORDERS_CEILING }
      ),
      supabase.from('stores').select('id, shop_id, shop_name, platform'),
    ])

    setOrdersTruncated(ordersRes.truncated === true)

    // Gates performSync below — see hasShopeeStoreRef.
    hasShopeeStoreRef.current = (storesRes.data ?? []).some((store) => store.platform === 'shopee')

    const storeNames = {}
    ;(storesRes.data ?? []).forEach((store) => {
      storeNames[store.id] = store.shop_name || store.shop_id
    })

    if (!ordersRes.error && ordersRes.data) {
      setOrders(ordersRes.data.map((row) => mapSupabaseOrder(row, storeNames)))
    } else {
      setOrders([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOrders()
  }, [fetchOrders])

  // Shared sync core for both the manual Sync button and the 60s auto-sync
  // tick. Does the network call only — no toasts, no spinner state — so each
  // caller can decide how loud to be about the result.
  const performSync = useCallback(async () => {
    // Nothing to sync if this account has no connected Shopee store (e.g. a
    // TikTok-only account) — calling the endpoint anyway would just come back
    // "No matching Shopee store found", which would read as a sync failure
    // rather than the no-op it actually is. This is a guard on an ALREADY
    // Shopee-only endpoint, not TikTok sync logic.
    if (!hasShopeeStoreRef.current) {
      return { ok: true, skipped: true }
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      return { ok: false, message: 'You must be logged in to sync.' }
    }

    let res
    try {
      res = await fetch(apiUrl('/api/shopee/sync?type=orders'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
    } catch (err) {
      console.error('[sync] network error calling /api/shopee/sync?type=orders', err)
      return { ok: false, message: `Sync failed: ${err.message || 'network error'}.` }
    }

    let data
    try {
      data = await res.json()
    } catch (err) {
      console.error('[sync] non-JSON response from /api/shopee/sync?type=orders', res.status, err)
      return { ok: false, message: `Sync failed: unexpected response (HTTP ${res.status}).` }
    }

    if (!res.ok || !data.success) {
      console.error('[sync] sync-orders failed', res.status, data)
      return { ok: false, message: describeSyncError(data) || `Sync failed (HTTP ${res.status}).` }
    }

    if (data.errors?.length) {
      console.error('[sync] partial sync failure', data.errors)
      return { ok: true, partial: true, data, message: describeSyncError(data) }
    }

    return { ok: true, data }
  }, [])

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await performSync()

      if (result.skipped) {
        toast.info(t('orders.sync.noStore'))
        return
      }

      if (!result.ok) {
        toast.error(result.message || t('orders.sync.error'))
        return
      }

      await fetchOrders()
      setLastSyncedAt(Date.now())
      setHasMorePending(Boolean(result.data?.hasMore))
      autoSyncErrorShownRef.current = false

      if (result.partial) {
        toast.error(result.message || t('orders.sync.partial'))
      } else {
        const count = result.data.synced ?? 0
        // Two whole sentences rather than a suffix concatenated onto one:
        // the trailing clause cannot be appended to a Chinese sentence and
        // still read as grammar.
        toast.success(
          result.data.hasMore
            ? t('orders.sync.successMore', { count })
            : t('orders.sync.success', { count })
        )
      }
    } catch (err) {
      console.error('[sync] unexpected error during manual sync', err)
      toast.error(err.message || t('orders.sync.error'))
    } finally {
      setSyncing(false)
    }
  }

  // Silent counterpart used by the 60s auto-sync tick: no spinner, no success
  // toast, and errors only toast once per consecutive-failure streak so a
  // disconnected store doesn't spam a toast every minute.
  const runAutoSync = useCallback(async () => {
    if (syncInFlightRef.current || selectionModeRef.current) return

    syncInFlightRef.current = true
    try {
      const result = await performSync()

      if (result.skipped) return

      if (!result.ok || result.partial) {
        console.error('[auto-sync] sync problem', result.message)
        if (!autoSyncErrorShownRef.current) {
          toast.error(result.message || t('orders.sync.autoError'))
          autoSyncErrorShownRef.current = true
        }
        if (result.ok) {
          await fetchOrders()
          setLastSyncedAt(Date.now())
          setHasMorePending(Boolean(result.data?.hasMore))
        }
        return
      }

      await fetchOrders()
      setLastSyncedAt(Date.now())
      setHasMorePending(Boolean(result.data?.hasMore))
      autoSyncErrorShownRef.current = false
    } finally {
      syncInFlightRef.current = false
    }
    // `t` is a dependency because the auto-sync failure toast reads it; its
    // identity only changes on a locale switch.
  }, [performSync, fetchOrders, t])

  // 60s auto-sync: only while this page is mounted, the tab is visible, and
  // the user has the preference on. Reads the localStorage toggle once at
  // mount time — the page fully remounts on route change (React Router), so
  // navigating back from Settings after flipping it picks up the new value.
  useEffect(() => {
    if (!getAutoSyncOrdersEnabled()) return undefined

    let intervalId = null

    const start = () => {
      if (intervalId) return
      intervalId = setInterval(runAutoSync, AUTO_SYNC_INTERVAL_MS)
    }

    const stop = () => {
      if (!intervalId) return
      clearInterval(intervalId)
      intervalId = null
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stop()
    }
  }, [runAutoSync])

  // Ticks the "Updated Xs ago" label once a sync has happened this session.
  useEffect(() => {
    if (lastSyncedAt === null) return undefined
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowTick(Date.now())
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lastSyncedAt])

  function requestPrintAWB(order) {
    if (!order.platform_order_id || !order.store_id) {
      toast.error(t('orders.printAwb.realOrdersOnly'))
      return
    }
    // eslint-disable-next-line react-hooks/purity -- perf instrumentation, event-handler only
    const tapAt = Date.now()
    setPrintConfirm({ count: 1, run: () => handlePrintAWB(order, tapAt) })
  }

  // tapAt: Date.now() at the button tap, from requestPrintAWB above — the only caller.
  async function handlePrintAWB(order, tapAt) {
    setPrintingId(order.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('orders.printAwb.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/print-awb'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          store_id: order.store_id,
          order_sn_list: [order.platform_order_id],
        }),
      })

      const contentType = res.headers.get('content-type') || ''

      if (!res.ok || contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}))
        logPrintAwbFailure(`print AWB for ${order.platform_order_id}`, data)
        toast.error(printAwbErrorMessage(data))
        return
      }

      // eslint-disable-next-line react-hooks/purity -- perf instrumentation, event-handler only
      const blobStart = Date.now()
      const blob = await res.blob()
      // eslint-disable-next-line react-hooks/purity -- perf instrumentation, event-handler only
      console.log(`[awb][perf] res.blob(): ${Date.now() - blobStart}ms`)
      try {
        await deliverPdf(blob, `AWB-${order.platform_order_id}.pdf`)
      } catch (err) {
        console.error('[print-awb] PDF did not reach the device', err)
        toast.error(t('orders.printAwb.deliveryErrorSingle'))
        return
      }
      // Includes time spent on the confirm dialog, not just system latency —
      // see requestPrintAWB, where tapAt is captured at the button tap.
      // eslint-disable-next-line react-hooks/purity -- perf instrumentation, event-handler only
      console.log(`[awb][perf] tap-to-FileOpener total: ${Date.now() - tapAt}ms`)

      await finalizeAwbDelivery({
        storeId: order.store_id,
        accessToken: session.access_token,
        orderSnList: [order.platform_order_id],
      })
      await fetchOrders()
    } catch (err) {
      console.error('[print-awb] request failed', err)
      toast.error(describeRequestError(t, err, t('orders.printAwb.error')))
    } finally {
      setPrintingId(null)
    }
  }

  function getBulkPrintSelection() {
    const selected = orders.filter((order) => selectedIds.has(order.id))
    const realOrders = selected.filter(
      (order) => order.platform_order_id && order.store_id && order.statusKey !== STATUS.UNPAID
    )

    if (realOrders.length === 0) return null

    // The endpoint prints for a single store; scope to the first selected store.
    const storeId = realOrders[0].store_id
    const sameStoreOrders = realOrders.filter((order) => order.store_id === storeId)
    return { storeId, sameStoreOrders, realOrders }
  }

  function requestBulkPrintAWB() {
    const selection = getBulkPrintSelection()
    if (!selection) {
      toast.error(t('orders.printAwb.realOrdersOnly'))
      return
    }
    // eslint-disable-next-line react-hooks/purity -- perf instrumentation, event-handler only
    const tapAt = Date.now()
    setPrintConfirm({ count: selection.sameStoreOrders.length, run: () => handleBulkPrintAWB(tapAt) })
  }

  function confirmPendingPrint() {
    const pending = printConfirm
    setPrintConfirm(null)
    pending?.run()
  }

  async function handleConfirmPendingAwbPrint() {
    await confirmPendingAwbPrint()
    await fetchOrders()
  }

  // tapAt: Date.now() at the button tap, from requestBulkPrintAWB above — the only caller.
  async function handleBulkPrintAWB(tapAt) {
    const selection = getBulkPrintSelection()
    if (!selection) {
      toast.error(t('orders.printAwb.realOrdersOnly'))
      return
    }
    const { storeId, sameStoreOrders, realOrders } = selection
    const orderSnList = sameStoreOrders.map((order) => order.platform_order_id)

    setBulkPrinting(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('orders.printAwb.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/print-awb'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ store_id: storeId, order_sn_list: orderSnList }),
      })

      const contentType = res.headers.get('content-type') || ''

      // A single clean order comes back as an inline PDF; anything else returns
      // one document per logistics channel as base64 JSON.
      if (res.ok && contentType.includes('application/pdf')) {
        const blobStart = Date.now()
        const blob = await res.blob()
        console.log(`[awb][perf] res.blob(): ${Date.now() - blobStart}ms`)
        try {
          await deliverPdf(blob, awbFilename(orderSnList))
        } catch (err) {
          console.error('[bulk-print] PDF did not reach the device', err)
          toast.error(t('orders.printAwb.deliveryError'))
          return
        }
        // Includes time spent on the confirm dialog, not just system latency —
        // see requestBulkPrintAWB, where tapAt is captured at the button tap.
        console.log(`[awb][perf] tap-to-FileOpener total: ${Date.now() - tapAt}ms`)
        await finalizeAwbDelivery({ storeId, accessToken: session.access_token, orderSnList })
      } else {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          logPrintAwbFailure('bulk print', data)
          toast.error(printAwbErrorMessage(data, t('orders.printAwb.bulkError')))
          return
        }

        const { fileCount, deliveredOrderSns } = await downloadAwbResponse(
          data,
          awbFilename(data.printed_order_sn_list ?? orderSnList)
        )
        if (fileCount === 0) {
          logPrintAwbFailure('bulk print (no pdf)', data)
          toast.error(t('orders.printAwb.deliveryError'))
          return
        }
        // documents.length PDFs deliver sequentially inside downloadAwbResponse
        // (DOWNLOAD_STAGGER_MS apart), so this total covers all of them, not
        // just the last one.
        console.log(`[awb][perf] tap-to-FileOpener total (${fileCount} file(s)): ${Date.now() - tapAt}ms`)

        await finalizeAwbDelivery({ storeId, accessToken: session.access_token, orderSnList: deliveredOrderSns })

        const orderCount = deliveredOrderSns.length
        toast.success(t('orders.printAwb.downloaded', { files: fileCount, orders: orderCount }))

        if (data.skipped_orders?.length) {
          toast.info(t('orders.printAwb.notReady', { count: data.skipped_orders.length }))
        }

        if (data.failed?.length) {
          // reason is Shopee's own per-order text — passed through untranslated.
          toast.error(
            t('orders.printAwb.failed', {
              count: data.failed.length,
              reason: describeFailedOrders(data.failed),
            })
          )
        }
      }

      if (sameStoreOrders.length < realOrders.length) {
        toast.info(
          t('orders.printAwb.sameStoreOnly', {
            printed: sameStoreOrders.length,
            selected: realOrders.length,
          })
        )
      }

      await fetchOrders()
    } catch (err) {
      console.error('[bulk-print] request failed', err)
      toast.error(describeRequestError(t, err, t('orders.printAwb.bulkError')))
    } finally {
      setBulkPrinting(false)
    }
  }

  // Shopee has no separate "pack" API: arranging shipment via ship_order is
  // what moves READY_TO_SHIP -> PROCESSED and makes Shopee show "seller is
  // preparing the parcel". So packing is a real API call, not a local nudge.
  async function handlePackOrder(order) {
    if (!order.platform_order_id || !order.store_id) {
      toast.error(t('orders.pack.realOrdersOnly'))
      return
    }

    setActingId(order.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('orders.loginRequired'))
        return
      }

      const { ok, error } = await postOrderAction(session, order, 'ship')
      if (!ok) {
        toast.error(error || t('orders.pack.error'))
        return
      }

      toast.success(t('orders.pack.success'))
      await fetchOrders()
    } catch (err) {
      console.error('[pack-order] request failed', err)
      toast.error(describeRequestError(t, err, t('orders.pack.error')))
    } finally {
      setActingId(null)
    }
  }

  async function handleShipOrder(order, { silent = false, skipRefetch = false } = {}) {
    if (!order.platform_order_id || !order.store_id) {
      if (!silent) toast.error(t('orders.ship.realOrdersOnly'))
      return false
    }

    setActingId(order.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        if (!silent) toast.error(t('orders.loginRequired'))
        return false
      }

      const { ok, error } = await postOrderAction(session, order, 'ship')
      if (!ok) {
        if (!silent) toast.error(error || t('orders.ship.error'))
        return false
      }

      if (!silent) toast.success(t('orders.ship.success'))
      if (!skipRefetch) await fetchOrders()
      return true
    } catch (err) {
      console.error('[ship-order] request failed', err)
      if (!silent) toast.error(describeRequestError(t, err, t('orders.ship.error')))
      return false
    } finally {
      setActingId(null)
    }
  }

  async function handleCancelOrder(order, { silent = false, skipRefetch = false, skipConfirm = false } = {}) {
    if (!order.platform_order_id || !order.store_id) {
      if (!silent) toast.error(t('orders.cancel.realOrdersOnly'))
      return false
    }

    if (!skipConfirm && !window.confirm(`Cancel order ${order.id}? This cannot be undone.`)) {
      return false
    }

    setActingId(order.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        if (!silent) toast.error(t('orders.loginRequired'))
        return false
      }

      const { ok, error } = await postOrderAction(session, order, 'cancel')
      if (!ok) {
        if (!silent) toast.error(error || t('orders.cancel.error'))
        return false
      }

      if (!silent) toast.success(t('orders.cancel.success'))
      if (!skipRefetch) await fetchOrders()
      return true
    } catch (err) {
      console.error('[cancel-order] request failed', err)
      if (!silent) toast.error(describeRequestError(t, err, t('orders.cancel.error')))
      return false
    } finally {
      setActingId(null)
    }
  }

  // Approve/reject a buyer's cancellation request. Both are irreversible from
  // the seller's side, so both confirm first (echoing the buyer's reason so
  // the decision is made against it). The backend NEVER trusts Shopee's
  // response — it re-syncs the order and returns the real status — so on any
  // outcome (approved / rejected / already-resolved) we refetch, which
  // replaces this row with its true status and retires the buttons rather than
  // leaving a stale row the seller could click again.
  async function handleBuyerCancel(order, decision) {
    if (!order.platform_order_id || !order.store_id) {
      toast.error(t('orders.buyerCancel.realOrdersOnly'))
      return
    }

    // Keyed on the DECISION, not on an English verb. This used to build its
    // failure message as `Failed to ${verb.toLowerCase()} cancellation.` —
    // English morphology assembled at runtime, which no dictionary can reach.
    const decisionKey = decision === 'accept' ? 'approve' : 'reject'
    const reason =
      order.buyerCancelReason || order.cancelReason || t('orders.buyerCancel.noReason')
    const confirmMsg = t(`orders.buyerCancel.confirm.${decisionKey}`, {
      id: order.id,
      reason,
    })

    if (!window.confirm(confirmMsg)) return

    setActingId(order.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('orders.loginRequired'))
        return
      }

      const { ok, error, data } = await postOrderAction(
        session,
        order,
        decision === 'accept' ? 'accept_buyer_cancel' : 'reject_buyer_cancel'
      )

      // Always refetch: whether it succeeded, was already resolved, or failed,
      // the order's real status may have moved — pulling it fresh clears any
      // stale row + dead buttons.
      await fetchOrders()

      if (!ok) {
        toast.error(error || t(`orders.buyerCancel.error.${decisionKey}`))
        return
      }

      // already_resolved is the common first case (these were buried in the
      // Cancelled tab and may have auto-accepted). Show it as info, not a
      // celebratory success, so it reads as "nothing for you to do here".
      if (data?.already_resolved) {
        toast.info(data.message || t('orders.buyerCancel.alreadyResolved'))
      } else {
        toast.success(data?.message || t(`orders.buyerCancel.success.${decisionKey}`))
      }
    } catch (err) {
      console.error('[buyer-cancel] request failed', err)
      toast.error(describeRequestError(t, err, t(`orders.buyerCancel.error.${decisionKey}`)))
    } finally {
      setActingId(null)
    }
  }

  async function handleBulkShip() {
    const selected = orders.filter((o) => selectedIds.has(o.id))
    const realOrders = selected.filter(
      (o) => o.platform_order_id && o.store_id && o.statusKey !== STATUS.UNPAID
    )

    if (realOrders.length === 0) {
      toast.error(t('orders.ship.realOrdersOnly'))
      return
    }

    setBulkActing('ship')
    try {
      let succeeded = 0
      for (const order of realOrders) {
        const ok = await handleShipOrder(order, { silent: true, skipRefetch: true })
        if (ok) succeeded += 1
      }

      if (succeeded > 0) {
        toast.success(t('orders.bulk.shipped', { succeeded, total: realOrders.length }))
      } else {
        toast.error(t('orders.bulk.shipError'))
      }

      await fetchOrders()
      setSelectionMode(false)
      setSelectedIds(new Set())
    } finally {
      setBulkActing(null)
    }
  }

  async function handleBulkCancel() {
    const selected = orders.filter((o) => selectedIds.has(o.id))
    const realOrders = selected.filter(
      (o) => o.platform_order_id && o.store_id && o.statusKey !== STATUS.UNPAID
    )

    if (realOrders.length === 0) {
      toast.error(t('orders.cancel.realOrdersOnly'))
      return
    }

    if (!window.confirm(`Cancel ${realOrders.length} order(s)? This cannot be undone.`)) {
      return
    }

    setBulkActing('cancel')
    try {
      let succeeded = 0
      for (const order of realOrders) {
        const ok = await handleCancelOrder(order, {
          silent: true,
          skipRefetch: true,
          skipConfirm: true,
        })
        if (ok) succeeded += 1
      }

      if (succeeded > 0) {
        toast.success(t('orders.bulk.cancelled', { succeeded, total: realOrders.length }))
      } else {
        toast.error(t('orders.bulk.cancelError'))
      }

      await fetchOrders()
      setSelectionMode(false)
      setSelectedIds(new Set())
    } finally {
      setBulkActing(null)
    }
  }

  const tabCounts = useMemo(() => {
    const counts = {}
    orders.forEach((order) => {
      if (platformFilter !== ALL_FILTER && order.platform !== platformFilter) return
      const tab = getOrderTab(order)
      counts[tab] = (counts[tab] ?? 0) + 1
    })
    return counts
  }, [orders, platformFilter])

  const platformCounts = useMemo(() => {
    const counts = { [ALL_FILTER]: 0, Shopee: 0, Lazada: 0, TikTok: 0, Shopify: 0 }
    orders.forEach((order) => {
      if (getOrderTab(order) !== activeTab) return
      counts[ALL_FILTER] += 1
      counts[order.platform] = (counts[order.platform] ?? 0) + 1
    })
    return counts
  }, [orders, activeTab])

  // Everything sitting in the To Pack tab for the current platform filter.
  // Deliberately ignores the search box and the printed chip: "Print All"
  // should cover the whole tab, not just what happens to be on screen.
  const toPackOrders = orders.filter(
    (order) =>
      getOrderTab(order) === TO_PACK_TAB &&
      (platformFilter === ALL_FILTER || order.platform === platformFilter)
  )

  const unprintedCount = toPackOrders.filter(
    (order) => order.platform_order_id && order.store_id && !order.awbPrinted
  ).length

  const filteredOrders = orders.filter((order) => {
    if (getOrderTab(order) !== activeTab) return false
    if (platformFilter !== ALL_FILTER && order.platform !== platformFilter) return false
    if (activeTab === TO_PACK_TAB && printedFilter !== ALL_FILTER) {
      const wantPrinted = printedFilter === 'printed'
      if (Boolean(order.awbPrinted) !== wantPrinted) return false
    }
    const q = search.trim().toLowerCase()
    if (q && !order.id.toLowerCase().includes(q) && !order.buyer.toLowerCase().includes(q)) {
      return false
    }
    return true
  })

  function toggleSelectionMode() {
    setSelectionMode((v) => !v)
    setSelectedIds(new Set())
  }

  function handleCardClick(order) {
    if (selectionMode) {
      if (order.statusKey === STATUS.UNPAID) return
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(order.id)) next.delete(order.id)
        else next.add(order.id)
        return next
      })
    } else {
      setSelectedOrder(order)
    }
  }

  return (
    <div className={cn('pb-24', selectionMode && 'pb-40')}>
      <div className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4">
        <div className="flex items-center justify-between gap-2 pb-3">
          <h1 className="text-xl font-bold tracking-tight text-[#1F2937]">{t('orders.title')}</h1>
          <div className="flex items-center gap-2">
            {activeTab === TO_PACK_TAB && (
              <Button
                size="sm"
                onClick={() => navigate('/bulk-print')}
                disabled={unprintedCount === 0}
                className="h-9 rounded-lg px-3 text-[13px] font-medium bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
              >
                <Printer className="h-4 w-4" />
                {unprintedCount > 0
                  ? t('orders.printAllCount', { count: unprintedCount })
                  : t('orders.printAll')}
              </Button>
            )}
            {lastSyncedAt !== null && nowTick !== null && (
              <span className="hidden items-center gap-1.5 text-xs tabular-nums text-gray-400 sm:flex">
                {t('orders.updatedAgo', { ago: formatShortAgo(nowTick - lastSyncedAt) })}
                {hasMorePending && (
                  <span
                    title={t('orders.catchingUpHint')}
                    className={cn(BADGE_CLS, 'bg-amber-500/15 text-amber-700')}
                  >
                    {t('orders.catchingUp')}
                  </span>
                )}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate('/scan')}
              aria-label={t('orders.scanAria')}
              className="h-9 w-9 rounded-lg border-[#E8E6E1] px-0 text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
            >
              <ScanLine className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSync}
              disabled={syncing}
              className="h-9 rounded-lg border-[#E8E6E1] px-3 text-[13px] font-medium text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('orders.sync.button')}
            </Button>
          </div>
        </div>
        {lastSyncedAt !== null && nowTick !== null && (
          <div className="flex justify-end pb-1.5 sm:hidden">
            <span className="flex items-center gap-1.5 text-xs tabular-nums text-gray-400">
              {t('orders.updatedAgo', { ago: formatShortAgo(nowTick - lastSyncedAt) })}
              {hasMorePending && (
                <span
                  title={t('orders.catchingUpHint')}
                  className={cn(BADGE_CLS, 'bg-amber-500/15 text-amber-700')}
                >
                  {t('orders.catchingUp')}
                </span>
              )}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between border-b border-[#E8E6E1]">
          <div className="flex gap-5 overflow-x-auto">
            {TABS.map((tab) => {
              const active = activeTab === tab.key
              const count = tabCounts[tab.key] ?? 0
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 py-2.5 text-sm transition-colors',
                    active ? 'border-[#2563EB] font-semibold text-[#1F2937]' : 'border-transparent font-medium text-[#6B7280]'
                  )}
                >
                  {t(`orders.tabs.${tab.key}`)}
                  {tab.badgeClass && (
                    <span
                      className={cn(
                        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums',
                        tab.badgeClass
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <button
            onClick={toggleSelectionMode}
            className="shrink-0 rounded-md px-2 py-2.5 text-sm font-semibold text-[#2563EB] transition-colors hover:bg-[#2563EB]/5 active:bg-[#2563EB]/10"
          >
            {selectionMode ? 'Done' : 'Select'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto px-4 py-2.5">
        {PLATFORM_FILTERS.map((platform) => {
          const active = platformFilter === platform
          const isAll = platform === ALL_FILTER
          const activeClass = isAll
            ? 'bg-[#2563EB] text-white'
            : PLATFORM_META[platform].chipActive
          return (
            <button
              key={platform}
              onClick={() => setPlatformFilter(platform)}
              className={cn(
                'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                active ? activeClass : 'bg-[#F3F4F6] text-[#6B7280]'
              )}
            >
              {isAll ? t('orders.filters.all') : platform} ({platformCounts[platform] ?? 0})
            </button>
          )
        })}
      </div>

      {activeTab === TO_PACK_TAB && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2.5">
          {PRINTED_FILTERS.map((option) => {
            const active = printedFilter === option
            return (
              <button
                key={option}
                onClick={() => setPrintedFilter(option)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#2563EB]'
                    : 'border-[#E8E6E1] bg-white text-[#6B7280]'
                )}
              >
                {t(`orders.printedFilters.${option}`)}
              </button>
            )
          })}
        </div>
      )}

      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('orders.searchPlaceholder')}
            className="h-11 !bg-white rounded-xl border-[#E8E6E1] pl-9 pr-9 text-[#1F2937] placeholder:text-gray-400"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label={t('orders.clearSearch')}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {ordersTruncated && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-xl border border-yellow-300 bg-yellow-50 p-3">
          <Package className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <p className="text-xs text-yellow-800">
            {t('orders.truncated', { count: ORDERS_CEILING.toLocaleString() })}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3.5 px-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-[#E8E6E1] bg-white p-4 shadow-card">
              <Skeleton className="h-4 w-24 bg-gray-200" />
              <Skeleton className="mt-3 h-4 w-40 bg-gray-200" />
              <Skeleton className="mt-2.5 h-3 w-32 bg-gray-200" />
              <Skeleton className="mt-4 h-9 w-full bg-gray-200" />
            </div>
          ))
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F3F4F6]">
              <Package className="h-6 w-6 text-gray-400" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#1F2937]">{t('orders.empty.title')}</p>
              <p className="text-xs text-[#6B7280]">{t('orders.empty.hint')}</p>
            </div>
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F3F4F6]">
              <Search className="h-6 w-6 text-gray-400" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#1F2937]">{t('orders.noResults.title')}</p>
              <p className="text-xs text-[#6B7280]">{t('orders.noResults.hint')}</p>
            </div>
          </div>
        ) : (
          filteredOrders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onClick={handleCardClick}
              selectionMode={selectionMode}
              selected={selectedIds.has(order.id)}
              onPrintAWB={requestPrintAWB}
              printingId={printingId}
              onPack={handlePackOrder}
              onCancel={handleCancelOrder}
              onBuyerCancel={handleBuyerCancel}
              actingId={actingId}
            />
          ))
        )}
      </div>

      {selectionMode && (
        <div className="fixed inset-x-0 bottom-16 z-40 flex items-center justify-between gap-2 border-t border-[#E8E6E1] bg-white px-4 py-3.5 shadow-[0_-2px_8px_-2px_rgb(15_23_42_/_0.08)]">
          <span className="text-sm font-semibold tabular-nums text-[#1F2937]">
            {t('orders.selectedCount', { count: selectedIds.size })}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={requestBulkPrintAWB}
              disabled={bulkPrinting}
              className={cn(ACTION_BTN_CLS, 'border-[#E8E6E1] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]')}
            >
              {bulkPrinting ? <Loader2 className="animate-spin" /> : <Printer />}{' '}
              {t('orders.actions.printLabel')}
            </Button>
            <Button
              size="sm"
              onClick={handleBulkShip}
              disabled={bulkActing === 'ship'}
              className={cn(ACTION_BTN_CLS, 'bg-[#2563EB] text-white hover:bg-[#2563EB]/90')}
            >
              {bulkActing === 'ship' ? <Loader2 className="animate-spin" /> : <Truck />}{' '}
              {t('orders.actions.ship')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleBulkCancel}
              disabled={bulkActing === 'cancel'}
              className={cn(ACTION_BTN_CLS, 'text-red-600 hover:bg-red-500/10 hover:text-red-600')}
            >
              {bulkActing === 'cancel' ? <Loader2 className="animate-spin" /> : null}{' '}
              {t('orders.actions.cancel')}
            </Button>
          </div>
        </div>
      )}

      <Sheet open={!!selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)}>
        <SheetContent
          side="bottom"
          className="!h-screen w-full gap-0 rounded-t-2xl border-[#E8E6E1] bg-white p-0"
        >
          {selectedOrder && (
            <>
              <SheetHeader className="border-b border-[#E8E6E1] px-4 py-4">
                <SheetTitle className="flex items-center gap-2 text-base text-[#1F2937]">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      PLATFORM_META[selectedOrder.platform].badge
                    )}
                  >
                    {selectedOrder.platform}
                  </span>
                  <span className="font-mono text-sm text-[#6B7280]">{selectedOrder.id}</span>
                </SheetTitle>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                <span
                  className={cn(
                    'inline-block rounded-full px-2.5 py-1 text-[11px] font-medium',
                    (selectedOrder.statusKey ? STATUS_BADGE[selectedOrder.statusKey] : undefined) ??
                      DEFAULT_STATUS_BADGE
                  )}
                >
                  {statusLabel(t, selectedOrder)}
                </span>

                {selectedOrder.statusKey === STATUS.CANCEL_REQUESTED && (
                  <div className="mt-4 rounded-xl bg-amber-500/10 px-3 py-3 text-xs leading-snug text-amber-800">
                    <p className="text-sm font-semibold">{t('orders.cancelRequest.title')}</p>
                    <p className="mt-1.5">
                      <span className="text-amber-700">{t('orders.cancelRequest.reason')}: </span>
                      {selectedOrder.buyerCancelReason ||
                        selectedOrder.cancelReason ||
                        t('orders.cancelRequest.notProvided')}
                    </p>
                    <p className="mt-1.5 text-amber-700">{t('orders.cancelRequest.deadline')}</p>
                  </div>
                )}

                {selectedOrder.buyerMessage && (
                  <div className="mt-4 rounded-xl bg-blue-500/10 px-3 py-3 text-xs leading-snug text-blue-800">
                    <p className="text-sm font-semibold">{t('orders.buyerMessage.title')}</p>
                    <p className="mt-1.5 whitespace-pre-wrap">{selectedOrder.buyerMessage}</p>
                    <p className="mt-1.5 text-blue-700">{t('orders.buyerMessage.hint')}</p>
                  </div>
                )}

                <section className="mt-5">
                  <h3 className="text-[11px] font-semibold tracking-wide text-[#9CA3AF] uppercase">
                    {t('orders.sections.buyer')}
                  </h3>
                  {/* Name, phone, address, region are all Shopee DATA. */}
                  <p className="mt-1.5 text-sm font-semibold text-[#1F2937]">
                    {selectedOrder.buyer ?? t('orders.unknownBuyer')}
                  </p>
                  <p className="mt-0.5 text-xs text-[#6B7280]">{selectedOrder.phone}</p>
                  <p className="text-xs text-[#6B7280]">{selectedOrder.address}</p>
                  <p className="text-xs text-[#9CA3AF]">{selectedOrder.region}</p>
                </section>

                <Separator className="my-4 bg-[#E8E6E1]" />

                <section>
                  <h3 className="text-[11px] font-semibold tracking-wide text-[#9CA3AF] uppercase">
                    {t('orders.sections.shipping')}
                  </h3>
                  <div className="mt-2.5 space-y-1.5 text-xs">
                    <div className="flex justify-between text-[#6B7280]">
                      <span>{t('orders.fields.marketplaceStatus')}</span>
                      <span className="text-[#1F2937]">{getMarketplaceStatus(t, selectedOrder)}</span>
                    </div>
                    {selectedOrder.courier && (
                      <div className="flex justify-between text-[#6B7280]">
                        <span>{t('orders.fields.logistics')}</span>
                        <span className="text-[#1F2937]">
                          {selectedOrder.platform}-MY-{selectedOrder.courier}
                        </span>
                      </div>
                    )}
                    {selectedOrder.shippingMethod && (
                      <div className="flex justify-between text-[#6B7280]">
                        <span>{t('orders.arrangedVia')}</span>
                        <span className="text-[#1F2937]">
                          {shippingMethodLabel(t, selectedOrder.shippingMethod)}
                        </span>
                      </div>
                    )}
                    {selectedOrder.trackingNumber && (
                      <div className="flex items-center justify-between text-[#6B7280]">
                        <span>{t('orders.fields.trackingNo')}</span>
                        <span className="flex items-center gap-1 font-mono text-[#1F2937]">
                          {selectedOrder.trackingNumber}
                          <CopyButton text={selectedOrder.trackingNumber} />
                        </span>
                      </div>
                    )}
                    {selectedOrder.paidAt && (
                      <div className="flex justify-between text-[#6B7280]">
                        <span>{t('orders.fields.paid')}</span>
                        <span className="text-[#1F2937]">{formatDateTime(selectedOrder.paidAt)}</span>
                      </div>
                    )}
                    {selectedOrder.packedAt && (
                      <div className="flex justify-between text-[#6B7280]">
                        <span>{t('orders.fields.packed')}</span>
                        <span className="text-[#1F2937]">
                          {formatDateTime(selectedOrder.packedAt)}
                          {selectedOrder.packedBy === 'auto' ? ` ${t('orders.fields.autoSuffix')}` : ''}
                        </span>
                      </div>
                    )}
                    {selectedOrder.autoPackStatus === 'failed' && (
                      <div className="rounded-lg bg-red-500/10 px-2 py-1.5 text-red-700">
                        <p className="font-medium">⚠️ {t('orders.autoPack.failed')}</p>
                        {/* autoPackError is the server's own reason — verbatim. */}
                        <p className="mt-0.5 text-[11px]">
                          {selectedOrder.autoPackError || t('orders.autoPack.unknownError')}
                        </p>
                        <p className="mt-0.5 text-[11px] text-red-600">
                          {t('orders.autoPack.noRetry')}
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                <Separator className="my-4 bg-[#E8E6E1]" />

                <section>
                  <h3 className="text-[11px] font-semibold tracking-wide text-[#9CA3AF] uppercase">
                    {t('orders.sections.items')}
                  </h3>
                  <div className="mt-2.5 space-y-2.5">
                    {selectedOrder.items.map((item, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <ItemThumb
                          image={item.image}
                          alt={item.name ?? t('orders.unnamedItem')}
                          tint={PLATFORM_META[selectedOrder.platform].tint}
                          className="h-10 w-10"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-[#1F2937]">
                            {item.name ?? t('orders.unnamedItem')}
                          </p>
                          <p className="text-xs text-[#6B7280]">
                            {t('orders.fields.qty')}: {item.qty}
                            {item.variant ? ` • ${item.variant}` : ''}
                          </p>
                        </div>
                        <p className="shrink-0 text-sm tabular-nums text-[#1F2937]">RM {item.price.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <Separator className="my-4 bg-[#E8E6E1]" />

                <section className="space-y-1.5">
                  <div className="flex justify-between text-sm text-[#6B7280]">
                    <span>{t('orders.fields.subtotal')}</span>
                    <span className="tabular-nums">RM {selectedOrder.total.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-[#6B7280]">
                    <span>{t('orders.fields.shippingFee')}</span>
                    <span className="tabular-nums">RM 0.00</span>
                  </div>
                  <div className="flex justify-between border-t border-[#F1F0EC] pt-1.5 text-sm font-semibold text-[#1F2937]">
                    <span>{t('orders.fields.total')}</span>
                    <span className="tabular-nums">RM {selectedOrder.total.toFixed(2)}</span>
                  </div>
                </section>

                <Separator className="my-4 bg-[#E8E6E1]" />

                <section>
                  <h3 className="mb-3 text-[11px] font-semibold tracking-wide text-[#9CA3AF] uppercase">
                    {t('orders.sections.timeline')}
                  </h3>
                  <OrderTimeline
                    statusKey={selectedOrder.statusKey}
                    statusLabel={statusLabel(t, selectedOrder)}
                  />
                </section>
              </div>

              {renderActions(t, selectedOrder, { fullWidth: true }) && (
                <SheetFooter className="flex-row gap-2 border-t border-[#E8E6E1] px-4 py-4">
                  {renderActions(t, selectedOrder, {
                    fullWidth: true,
                    onPrintAWB: requestPrintAWB,
                    printingId,
                    onPack: handlePackOrder,
                    onCancel: handleCancelOrder,
                    onBuyerCancel: handleBuyerCancel,
                    actingId,
                  })}
                </SheetFooter>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      <PrintAwbConfirmDialog
        open={Boolean(printConfirm)}
        count={printConfirm?.count ?? 1}
        onCancel={() => setPrintConfirm(null)}
        onConfirm={confirmPendingPrint}
      />

      <PrintAwbMarkPrintedDialog
        open={Boolean(pendingAwbPrint)}
        count={pendingAwbPrint?.orderSnList?.length ?? 1}
        onCancel={dismissPendingAwbPrint}
        onConfirm={handleConfirmPendingAwbPrint}
      />
    </div>
  )
}
