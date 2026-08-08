import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy as CopyIcon,
  Eye,
  Loader2,
  Package,
  RefreshCw,
  Repeat,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'
import { apiUrl, describeRequestError } from '@/lib/apiBase'

// Dense row view of Shopee flash sale sessions.
//
// Sync is read-only — it pulls fresh data, it never writes to Shopee. Copy is
// the one write path (see COPY_ENABLED below).
//
// Deliberately NOT shown: "stock left" / "units sold". Shopee's
// get_shop_flash_sale_items exposes no such field — campaign_stock is the
// ALLOCATED quota and never decrements, and `stock` is the product's live stock
// rather than a campaign figure. Showing either as "left" would be a lie, so
// this page shows the quota, the prices, engagement, and the countdown only.

// Mirrors COPY_ENABLED in api/_lib/flashSaleCopy.js. The browser cannot import
// that module, so the flag exists twice on purpose — flip BOTH together. The
// server gate is the one that actually protects Shopee; this one only decides
// whether the UI looks interactive.
//
// Enabled 2026-07-28 after the 2 Aug slot-ownership test passed.
const COPY_ENABLED = true
const COPY_DISABLED_HINT = 'Copy is coming soon — pending the 2 Aug slot-ownership test'

// ===================== MULTI-SLOT COPY: PACING =============================
// A copy targets ONE slot per request — api/shopee/copy-flash-sale.js runs
// maxDuration 30 against a 25s copy deadline, so two slots cannot share an
// invocation. Selecting N slots therefore means N sequential requests driven
// from this page, which is also what gives each slot its own sync_logs row and
// its own independent outcome.
//
// These three mirror the server's limiter. They exist here ONLY so the client
// spaces its own requests instead of discovering the ceiling by being 429'd —
// the server stays the enforcer, and a 429 is still handled below because
// another tab or device can spend budget this page cannot see.
const COPY_WINDOW_MS = 60_000
const COPY_MAX_PER_WINDOW = 3
// The window is rolling and counted server-side, so browser/server clock skew
// decides whether the 4th request lands just inside or just outside it. Slack
// is cheaper than a round-trip spent getting refused.
const COPY_WINDOW_MARGIN_MS = 2_000

// 12 slots = 4 windows ≈ 3 minutes. The batch runs in the page (there is no
// server-side queue), so this ceiling is really a ceiling on how long the user
// has to stay on this screen.
const COPY_MAX_SLOTS = 12

// A copy hard-killed by the platform never reaches logSyncComplete, so its
// 'started' row keeps holding acquireSyncLock for the full LOCK_TTL_MS (90s,
// api/_lib/shopeeSync.js). Every following slot then gets reason:'locked', and
// the server's retryAfterMs of 5s is a POLL interval, not a time-to-clear.
// Polling past the TTL is what stops one timed-out slot from failing the rest.
const LOCK_POLL_MS = 10_000
const LOCK_MAX_WAIT_MS = 100_000
const RATE_MAX_RETRIES = 3

// ===================== MULTI-SLOT COPY: RISK BUCKETS =======================
// BigSeller creates sessions in these same slots, and the ownership race is
// still UNOBSERVED — the 2 Aug test slot hasn't happened. Multi-select makes it
// easy to fill several near-term slots in one go, so the picker must not
// present every slot as equally safe.
//
// This is an explicit heuristic on lead time, not a measurement: the less
// notice a slot gives, the likelier BigSeller is already working it. The UI
// says so rather than implying the buckets are evidence.
const NEAR_TERM_MS = 48 * 3_600_000
const MID_TERM_MS = 7 * 24 * 3_600_000

const RISK_BUCKETS = [
  {
    key: 'near',
    label: 'Within 48h',
    note: 'Higher risk — the slot-ownership race with BigSeller is still untested',
    dot: 'bg-yellow-500',
    text: 'text-yellow-800',
  },
  { key: 'mid', label: '2–7 days out', note: 'Some lead time', dot: 'bg-gray-400', text: 'text-[#6B7280]' },
  {
    key: 'far',
    label: '7+ days out',
    note: 'Safest — most lead time before BigSeller would act',
    dot: 'bg-green-500',
    text: 'text-green-800',
  },
]

function slotRisk(slot, nowMs) {
  const lead = new Date(slot.start_time).getTime() - nowMs
  if (lead < NEAR_TERM_MS) return 'near'
  if (lead < MID_TERM_MS) return 'mid'
  return 'far'
}

/** Rough wall-clock cost of a batch, so the picker can warn before confirming. */
function estimateBatchMs(n) {
  if (n <= 0) return 0
  const waits = Math.floor((n - 1) / COPY_MAX_PER_WINDOW)
  return waits * (COPY_WINDOW_MS + COPY_WINDOW_MARGIN_MS) + n * 8_000
}

/**
 * How long before the next request may be sent, from the timestamps of requests
 * that actually consumed rate budget. Derived from the wall clock on every call
 * rather than from a running counter — a backgrounded mobile tab throttles
 * timers, and a stale counter would send early and get refused.
 */
function rateWaitMs(submissions, now) {
  if (submissions.length < COPY_MAX_PER_WINDOW) return 0
  const oldest = submissions[submissions.length - COPY_MAX_PER_WINDOW]
  return Math.max(0, oldest + COPY_WINDOW_MS + COPY_WINDOW_MARGIN_MS - now)
}

/** Sleeps in slices so an abort lands promptly and the deadline is re-read from
 *  the wall clock instead of trusted to a single long timer. */
async function sleepUntil(target, stopRef) {
  while (Date.now() < target) {
    if (stopRef.current) return
    await new Promise((r) => setTimeout(r, Math.min(500, target - Date.now())))
  }
}

// Shopee model status. 2 (deleted) never appears in a fetched list in practice
// but is mapped rather than falling through to "unknown".
const MODEL_STATUS = {
  0: { label: 'Disabled', cls: 'bg-gray-100 text-gray-600' },
  1: { label: 'Enabled', cls: 'bg-green-100 text-green-700' },
  2: { label: 'Deleted', cls: 'bg-gray-100 text-gray-500' },
  4: { label: 'System rejected', cls: 'bg-red-100 text-red-700' },
  5: { label: 'Manual rejected', cls: 'bg-red-100 text-red-700' },
}

// Session-level status. Distinct enum from MODEL_STATUS above — a session can
// be system-rejected while its items still read as enabled.
const SESSION_STATUS = {
  0: { label: 'Deleted', cls: 'bg-gray-100 text-gray-500' },
  1: { label: 'Enabled', cls: 'bg-green-100 text-green-700' },
  2: { label: 'Disabled', cls: 'bg-gray-100 text-gray-600' },
  3: { label: 'System rejected', cls: 'bg-red-100 text-red-700' },
}

// Server enforces a 60s per-session cooldown (SESSION_SYNC_COOLDOWN_MS in
// api/_lib/flashSaleSync.js). Mirrored here only to grey the button out.
const SYNC_COOLDOWN_MS = 60_000

const ITEM_SELECT =
  'id, item_id, model_id, item_name, model_name, image, status, original_price, ' +
  'input_promotion_price, promotion_price_with_tax, purchase_limit, campaign_stock, ' +
  'item_stock, reject_reason, products(image_url)'

const SESSION_SELECT =
  'id, store_id, flash_sale_id, timeslot_id, status, type, start_time, end_time, ' +
  'item_count, enabled_item_count_reported, enabled_item_count_derived, enabled_model_count, ' +
  'click_count, remindme_count, observed_at, stores(shop_name)'

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatRelative(iso, nowMs) {
  if (!iso) return 'never'
  const diff = nowMs - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * "2026-07-27" + "20:00-00:00", with nextDay set when the window closes on the
 * following local date — the 20:00-00:00 slot ends at midnight, which reads as
 * a zero-length range without the +1 marker.
 */
function slotRange(sale) {
  const s = new Date(sale.start_time)
  const e = new Date(sale.end_time)
  const t = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  return {
    date: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`,
    range: `${t(s)}-${t(e)}`,
    nextDay: dayKey(s) !== dayKey(e),
  }
}

function slotLabel(sale) {
  const { date, range, nextDay } = slotRange(sale)
  return `${date} ${range}${nextDay ? ' +1' : ''}`
}

function imageUrlFor(item) {
  // Prefer the synced product's real URL; the flash-sale endpoint only returns
  // a bare Shopee image id, which we turn into a CDN URL as a fallback.
  if (item.products?.image_url) return item.products.image_url
  if (item.image) return `https://down-my.img.susercontent.com/file/${item.image}`
  return null
}

// Live state derived from start/end times, NOT from the stored `type`. Shopee
// computes `type` at request time, so a row synced 2 minutes ago can already be
// stale — the clock is the only honest source between polls.
function liveState(sale, nowMs) {
  const start = new Date(sale.start_time).getTime()
  const end = new Date(sale.end_time).getTime()
  if (nowMs < start) return 'upcoming'
  if (nowMs >= end) return 'expired'
  return 'ongoing'
}

function formatDuration(ms) {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function Countdown({ sale, state, nowMs }) {
  if (state === 'ongoing') {
    const left = new Date(sale.end_time).getTime() - nowMs
    return <span className="font-medium text-[#EE4D2D]">Ends in {formatDuration(left)}</span>
  }
  if (state === 'upcoming') {
    const until = new Date(sale.start_time).getTime() - nowMs
    return <span className="font-medium text-[#2563EB]">Starts in {formatDuration(until)}</span>
  }
  return <span className="text-gray-400">Ended</span>
}

function Thumb({ url, className }) {
  if (url) {
    return <img src={url} alt="" className={cn('shrink-0 rounded-lg object-cover', className)} />
  }
  return (
    <div className={cn('flex shrink-0 items-center justify-center rounded-lg bg-[#EE4D2D]/10', className)}>
      <Package className="h-5 w-5 text-gray-400" />
    </div>
  )
}

/**
 * Status pill. A session that Shopee has rejected outranks its clock-derived
 * state — "Ended" on a rejected session hides the thing you actually need to
 * know, so the rejection wins the badge.
 */
function StatusBadge({ sale, state }) {
  const rejected = sale.status === 3
  const label = rejected
    ? 'Rejected'
    : state === 'ongoing'
      ? 'Ongoing'
      : state === 'upcoming'
        ? 'Upcoming'
        : 'Ended'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        rejected && 'bg-red-100 text-red-700',
        !rejected && state === 'ongoing' && 'bg-[#EE4D2D]/10 text-[#EE4D2D]',
        !rejected && state === 'upcoming' && 'bg-blue-50 text-[#2563EB]',
        !rejected && state === 'expired' && 'bg-gray-100 text-gray-500'
      )}
    >
      {label}
    </span>
  )
}

function Checkbox({ checked, onChange, label }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-[#E8E6E1] text-[#2563EB] accent-[#2563EB]"
    />
  )
}

/** Enabled / total items, with the expand affordance. */
function ItemCount({ sale, expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-xs text-[#1F2937] transition-colors hover:bg-[#F3F4F6]"
    >
      <span className="tabular-nums">
        {sale.enabled_item_count_derived ?? 0} / {sale.item_count ?? 0}
      </span>
      <ChevronDown className={cn('h-3.5 w-3.5 text-gray-400 transition-transform', expanded && 'rotate-180')} />
    </button>
  )
}

function ActionIcons({ sale, nowMs, syncing, onSync, onCopy, onDetails, className }) {
  // nowMs only ticks every 30s, so right after a sync it can still be BEHIND
  // observed_at — clamped at 0, otherwise the countdown briefly reads higher
  // than the cooldown itself (a 60s cooldown showing "63s").
  const since = Math.max(0, nowMs - new Date(sale.observed_at ?? 0).getTime())
  const cooling = since < SYNC_COOLDOWN_MS
  const secsLeft = Math.ceil((SYNC_COOLDOWN_MS - since) / 1000)

  const base =
    'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed'

  return (
    <div className={cn('flex shrink-0 items-center gap-1', className)}>
      <button
        type="button"
        onClick={() => onSync(sale)}
        disabled={syncing || cooling}
        title={cooling ? `Cooling down — ${secsLeft}s` : 'Refresh this session from Shopee'}
        className={cn(
          base,
          syncing || cooling
            ? 'border-[#E8E6E1] bg-[#F3F4F6] text-gray-400'
            : 'border-[#E8E6E1] bg-white text-[#2563EB] hover:bg-[#2563EB]/5'
        )}
      >
        {cooling && !syncing ? (
          <span className="text-[10px] font-medium tabular-nums">{secsLeft}</span>
        ) : (
          <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
        )}
      </button>

      {/* Disabled until the 2 Aug slot-ownership test resolves. `title` carries
          the reason rather than a bare greyed-out control. */}
      <button
        type="button"
        onClick={() => onCopy(sale)}
        disabled={!COPY_ENABLED}
        title={COPY_ENABLED ? 'Copy this session into a free slot' : COPY_DISABLED_HINT}
        className={cn(
          base,
          COPY_ENABLED
            ? 'border-[#E8E6E1] bg-white text-[#2563EB] hover:bg-[#2563EB]/5'
            : 'border-[#E8E6E1] bg-[#F3F4F6] text-gray-300'
        )}
      >
        <CopyIcon className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => onDetails(sale)}
        title="Open details"
        className={cn(base, 'border-[#E8E6E1] bg-white text-gray-500 hover:bg-[#F3F4F6]')}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

/**
 * One session. Renders TWO layouts from one set of props rather than a single
 * layout that scrolls sideways:
 *   - md+  : a true table row on the shared grid template
 *   - <md  : a three-line stack, because nine columns cannot fit 390px without
 *            either truncating text or introducing horizontal scroll
 * Both are always in the DOM; only one is displayed at a time.
 */
const GRID_COLS =
  'md:grid-cols-[28px_minmax(0,1fr)_132px_88px_60px_60px_92px_52px_116px]'

function SessionRow({
  sale,
  state,
  nowMs,
  selected,
  onSelect,
  expanded,
  onToggleExpand,
  syncing,
  onSync,
  onCopy,
  onDetails,
  autoRenew,
  onAutoRenew,
}) {
  const { date, range, nextDay } = slotRange(sale)

  const timeBlock = (
    <span className="flex items-baseline gap-1.5">
      <span className="text-sm font-medium tabular-nums text-[#1F2937]">{date}</span>
      <span className="text-sm tabular-nums text-[#1F2937]">{range}</span>
      {nextDay && (
        <span
          title="Ends the next day"
          className="rounded bg-[#F3F4F6] px-1 text-[10px] font-medium text-gray-500"
        >
          +1
        </span>
      )}
    </span>
  )

  return (
    <div className="border-b border-[#E8E6E1] last:border-b-0">
      {/* ---------------------------- desktop ---------------------------- */}
      <div className={cn('hidden items-center gap-3 px-3 py-2.5 md:grid', GRID_COLS)}>
        <Checkbox checked={selected} onChange={onSelect} label={`Select ${date} ${range}`} />

        <div className="min-w-0">
          {timeBlock}
          <p className="truncate text-xs text-[#6B7280]">{sale.stores?.shop_name ?? 'Store'}</p>
        </div>

        <span className="truncate font-mono text-[11px] text-gray-400">{sale.flash_sale_id}</span>

        <ItemCount sale={sale} expanded={expanded} onToggle={onToggleExpand} />

        <span className="flex items-center gap-1 text-xs tabular-nums text-[#6B7280]">
          <Eye className="h-3.5 w-3.5 shrink-0" /> {sale.click_count ?? 0}
        </span>
        <span className="flex items-center gap-1 text-xs tabular-nums text-[#6B7280]">
          <Bell className="h-3.5 w-3.5 shrink-0" /> {sale.remindme_count ?? 0}
        </span>

        <StatusBadge sale={sale} state={state} />

        <Switch checked={autoRenew} onCheckedChange={onAutoRenew} className="scale-90" />

        <ActionIcons
          sale={sale}
          nowMs={nowMs}
          syncing={syncing}
          onSync={onSync}
          onCopy={onCopy}
          onDetails={onDetails}
          className="justify-end"
        />
      </div>

      {/* ----------------------------- mobile ---------------------------- */}
      <div className="flex flex-col gap-1.5 px-3 py-2.5 md:hidden">
        <div className="flex items-center gap-2">
          <Checkbox checked={selected} onChange={onSelect} label={`Select ${date} ${range}`} />
          <div className="min-w-0 flex-1">{timeBlock}</div>
          <StatusBadge sale={sale} state={state} />
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-6 text-xs text-[#6B7280]">
          <span className="max-w-[40%] truncate">{sale.stores?.shop_name ?? 'Store'}</span>
          <ItemCount sale={sale} expanded={expanded} onToggle={onToggleExpand} />
          <span className="flex items-center gap-1 tabular-nums">
            <Eye className="h-3.5 w-3.5 shrink-0" /> {sale.click_count ?? 0}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <Bell className="h-3.5 w-3.5 shrink-0" /> {sale.remindme_count ?? 0}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 pl-6">
          <label className="flex items-center gap-1.5 text-[11px] text-[#6B7280]">
            <Repeat className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            Auto-renew
            <Switch checked={autoRenew} onCheckedChange={onAutoRenew} className="scale-90" />
          </label>
          <ActionIcons
            sale={sale}
            nowMs={nowMs}
            syncing={syncing}
            onSync={onSync}
            onCopy={onCopy}
            onDetails={onDetails}
          />
        </div>
      </div>
    </div>
  )
}

function ItemRow({ item }) {
  const orig = Number(item.original_price)
  const promo = Number(item.input_promotion_price)
  const withTax = Number(item.promotion_price_with_tax)
  const pct = orig > 0 && promo > 0 ? Math.round(((orig - promo) / orig) * 100) : null
  const status = MODEL_STATUS[item.status] ?? { label: `Status ${item.status}`, cls: 'bg-gray-100 text-gray-600' }
  // Shopee's criteria (get_item_criteria, criteria_id 12, category "All") require
  // min 10% off. Flagged rather than hidden: a variant sitting under the floor
  // is the reason a session gets rejected, and that should be visible here.
  const underDiscountFloor = pct != null && pct < 10

  return (
    <div className="flex items-start gap-3 border-b border-[#ECECEC] py-3 last:border-b-0">
      <Thumb url={imageUrlFor(item)} className="h-12 w-12" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[#1F2937]">{item.item_name ?? 'Untitled'}</p>
        <p className="truncate text-xs text-[#6B7280]">{item.model_name ?? '—'}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {promo > 0 && (
            <span className="text-sm font-semibold text-[#EE4D2D]">RM {promo.toFixed(2)}</span>
          )}
          {orig > 0 && (
            <span className="text-xs text-gray-400 line-through">RM {orig.toFixed(2)}</span>
          )}
          {pct > 0 && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                underDiscountFloor
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-[#EE4D2D]/10 text-[#EE4D2D]'
              )}
            >
              -{pct}%{underDiscountFloor && ' · under 10% floor'}
            </span>
          )}
        </div>
        {/* promotion_price_with_tax has been synced since day one but was never
            surfaced. Only shown when it actually differs from the input price. */}
        {withTax > 0 && Math.abs(withTax - promo) >= 0.01 && (
          <p className="mt-1 text-[11px] text-gray-500">Buyer pays incl. tax: RM {withTax.toFixed(2)}</p>
        )}
        {/* Quota, NOT "stock left" — Shopee does not expose units sold, and
            campaign_stock never decrements. See the note at the top of this file. */}
        <p className="mt-1 text-[11px] text-gray-500">
          Promo quota: {item.campaign_stock ?? 0}
          {item.purchase_limit > 0 && ` · max ${item.purchase_limit}/buyer`}
        </p>
        {/* Live product stock at last poll — deliberately labelled as such, NOT
            as campaign stock remaining, which this is not. */}
        {item.item_stock != null && (
          <p className="mt-0.5 text-[11px] text-gray-400">
            Product stock now: {item.item_stock}
            {item.item_stock === 0 && ' · out of stock'}
          </p>
        )}
        {item.reject_reason && <p className="mt-1 text-[11px] text-red-600">{item.reject_reason}</p>}
      </div>
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', status.cls)}>
        {status.label}
      </span>
    </div>
  )
}

function SessionDetails({ sale, nowMs }) {
  const status = SESSION_STATUS[sale.status] ?? {
    label: `Status ${sale.status}`,
    cls: 'bg-gray-100 text-gray-600',
  }
  // item_count is Shopee's own figure; the derived count comes from the items
  // endpoint. They disagree on expired sessions (Shopee reports
  // enabled_item_count=0 while the items endpoint still returns enabled models),
  // which is why both are shown rather than one being picked silently.
  const reported = sale.enabled_item_count_reported
  const derived = sale.enabled_item_count_derived
  const countsDisagree = reported != null && derived != null && reported !== derived

  return (
    <div className="border-b border-[#ECECEC] py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', status.cls)}>
          {status.label}
        </span>
        <span className="text-[11px] text-gray-400">
          Synced {formatRelative(sale.observed_at, nowMs)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Items in slot</dt>
          <dd className="text-[#1F2937]">{sale.item_count ?? 0}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Enabled items</dt>
          <dd className="text-[#1F2937]">{derived ?? 0}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Variants</dt>
          <dd className="text-[#1F2937]">{sale.enabled_model_count ?? 0}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Shopee reports</dt>
          <dd className={cn(countsDisagree ? 'text-yellow-700' : 'text-[#1F2937]')}>
            {reported ?? '—'}
          </dd>
        </div>
        <div className="col-span-2 flex justify-between gap-2">
          <dt className="text-gray-500">Flash sale ID</dt>
          <dd className="font-mono text-[10px] text-gray-500">{sale.flash_sale_id}</dd>
        </div>
        <div className="col-span-2 flex justify-between gap-2">
          <dt className="text-gray-500">Time slot ID</dt>
          <dd className="font-mono text-[10px] text-gray-500">{sale.timeslot_id ?? '—'}</dd>
        </div>
      </dl>

      {countsDisagree && (
        <p className="mt-2 text-[11px] text-yellow-700">
          Shopee reports {reported} enabled item(s), but the item list returns {derived}. The item
          list is the one to trust — Shopee zeroes this figure on ended sessions.
        </p>
      )}
    </div>
  )
}

// MOCK UI ONLY. No logic, no scheduling, no persistence — it exists so the
// layout can be judged before the real thing is built. It cannot renew
// anything: renewing means creating a flash sale on Shopee, which is the Copy
// path, and that is disabled.
function AutoRenewRow({ enabled, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#ECECEC] py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm text-[#1F2937]">
          <Repeat className="h-3.5 w-3.5 text-gray-400" />
          Auto-renew this slot
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
            Preview
          </span>
        </p>
        <p className="mt-0.5 text-[11px] text-gray-500">
          Not active yet — this toggle does nothing so far.
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * One slot's outcome within a batch. Success is NEVER inferred from the write
 * call — add_shop_flash_sale_items returns an empty body — so everything here
 * comes from the server's read-back diff, and anything short of an exact match
 * is shown as PARTIAL with the offending models named.
 *
 * Deliberately renders ONE slot. Outcomes are never merged across slots: a
 * batch where 3 of 5 landed cleanly has no honest single-line summary, and the
 * two that didn't are the whole reason to look.
 */
function CopySlotResult({ entry, tickMs }) {
  const result = entry.result
  // 'failed' means we hold no verdict at all — distinct from 'unverified',
  // which means the session exists but its contents could not be read back.
  const status = result?.status ?? (entry.error ? 'failed' : null)
  const ok = status === 'success'

  const tone = ok
    ? 'border-green-200 bg-green-50'
    : status === 'failed'
      ? 'border-red-200 bg-red-50'
      : status
        ? 'border-yellow-300 bg-yellow-50'
        : 'border-[#E8E6E1] bg-white'

  const secsLeft =
    entry.waitUntil != null ? Math.max(0, Math.ceil((entry.waitUntil - tickMs) / 1000)) : 0

  return (
    <div className={cn('rounded-xl border p-3 text-xs', tone)}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tabular-nums text-[#1F2937]">
          {entry.label}
        </span>
        {entry.state === 'running' && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-[#2563EB]">
            <Loader2 className="h-3 w-3 animate-spin" /> Copying
          </span>
        )}
        {entry.state === 'waiting' && (
          <span className="shrink-0 text-[10px] tabular-nums text-[#6B7280]">
            {entry.waitReason === 'lock' ? 'Waiting for lock' : 'Rate limit'} · {secsLeft}s
          </span>
        )}
        {entry.state === 'queued' && <span className="shrink-0 text-[10px] text-gray-400">Queued</span>}
        {entry.state === 'skipped' && <span className="shrink-0 text-[10px] text-gray-400">Skipped</span>}
      </div>

      {entry.state === 'waiting' && entry.waitReason === 'lock' && (
        <p className="mt-1 text-[11px] text-gray-600">
          An earlier copy still holds this store&apos;s lock. If it was killed mid-flight the lock
          clears on its own within 90s — this slot has not failed.
        </p>
      )}

      {status && (
        <p
          className={cn(
            'mt-1 font-medium',
            ok ? 'text-green-800' : status === 'failed' ? 'text-red-800' : 'text-yellow-900'
          )}
        >
          {ok
            ? `Copied — ${result.persistedCount}/${result.sentCount} models verified`
            : status === 'failed'
              ? 'FAILED — no flash sale confirmed'
              : `${status === 'unverified' ? 'UNVERIFIED' : 'PARTIAL'} — ${result.persistedCount ?? '?'}/${result.sentCount} models verified`}
        </p>
      )}

      {entry.error && <p className="mt-1 text-[11px] text-red-700">{entry.error}</p>}

      {/* The request went out but no verdict came back, so a session may or may
          not exist on this slot. Saying "failed" here would invite a retry that
          silently creates a duplicate. */}
      {entry.uncertain && (
        <p className="mt-1.5 text-[11px] text-red-700">
          The request was sent but its outcome is unknown — a session may still have been created on
          this slot. Check Shopee before retrying it.
        </p>
      )}

      {result && (
        <p className="mt-1 text-[11px] text-gray-600">
          New flash sale <span className="font-mono">{result.flashSaleId}</span> on slot{' '}
          <span className="font-mono">{result.timeslotId}</span>
        </p>
      )}

      {result?.addError && (
        <p className="mt-1.5 text-[11px] text-red-700">Add call reported: {result.addError}</p>
      )}
      {result?.readBackError && (
        <p className="mt-1.5 text-[11px] text-red-700">
          Read-back failed: {result.readBackError}. What landed is unknown — inspect the session on
          Shopee before retrying.
        </p>
      )}

      {result?.missing?.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-yellow-900">
            Sent but not persisted ({result.missing.length}):
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {result.missing.map((m) => (
              <li key={m.key} className="font-mono text-[10px] text-gray-600">
                {m.key} @ RM {Number(m.price).toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.priceMismatches?.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-yellow-900">
            Price drift ({result.priceMismatches.length}):
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {result.priceMismatches.map((m) => (
              <li key={m.key} className="font-mono text-[10px] text-gray-600">
                {m.key}: sent {Number(m.sent).toFixed(2)} → got {Number(m.persisted).toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.stockMismatches?.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-yellow-900">
            Quota drift ({result.stockMismatches.length}):
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {result.stockMismatches.map((m) => (
              <li key={m.key} className="font-mono text-[10px] text-gray-600">
                {m.key}: sent {m.sent} → got {m.persisted}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.rejected?.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-red-700">
            Rejected by Shopee ({result.rejected.length}):
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {result.rejected.map((m) => (
              <li key={m.key} className="text-[10px] text-red-700">
                <span className="font-mono">{m.key}</span>
                {m.modelName ? ` (${m.modelName})` : ''} — {m.reason ?? `status ${m.status}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Multi-select slot picker, opened over the Copy sheet.
 *
 * Checkboxes rather than a native multi-select: at 390px a native multiple
 * <select> collapses to a control that can't be operated one-handed and gives
 * no room for the risk grouping, which is the whole point of this screen.
 *
 * Slots are grouped by lead time (see RISK_BUCKETS) but stay in chronological
 * order inside each group, so picking is still predictable.
 */
function SlotPickerDialog({ open, onOpenChange, slots, consumedSlotIds, selected, onConfirm, nowMs }) {
  // Seeded once per mount. The caller remounts this component each time it
  // opens (see pickerSeq), which is what makes reopening to adjust a choice
  // start from the current selection instead of from empty — and it does so
  // without an effect that would re-seed mid-edit.
  const [picked, setPicked] = useState(() => new Set(selected))

  const groups = useMemo(() => {
    const out = { near: [], mid: [], far: [] }
    for (const s of slots ?? []) out[slotRisk(s, nowMs)].push(s)
    return out
  }, [slots, nowMs])

  const atCap = picked.size >= COPY_MAX_SLOTS

  const toggle = useCallback((id, next) => {
    setPicked((prev) => {
      const out = new Set(prev)
      if (next) {
        if (out.size >= COPY_MAX_SLOTS) return prev
        out.add(id)
      } else {
        out.delete(id)
      }
      return out
    })
  }, [])

  const estMs = estimateBatchMs(picked.size)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* bg-white, not the bg-popover DialogContent defaults to: `popover` is
          absent from tailwind.config.js's color map, so that class compiles to
          nothing and the popup renders transparent over the sheet behind it.
          Every SheetContent in this app hardcodes bg-white for the same reason. */}
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border border-[#E8E6E1] bg-white p-0 shadow-xl sm:max-w-md">
        <DialogHeader className="border-b border-[#E8E6E1] px-4 py-3 pr-12">
          <DialogTitle className="text-sm text-[#1F2937]">Choose time slots</DialogTitle>
          <DialogDescription className="text-[11px] text-[#6B7280]">
            Free slots in the 18-day horizon. Pick up to {COPY_MAX_SLOTS} — each one becomes its own
            flash sale.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-4 py-3">
          {slots === null ? (
            <div className="space-y-1.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-400">
              No free slots in the 18-day horizon for this store.
            </p>
          ) : (
            RISK_BUCKETS.map((bucket) => {
              const rows = groups[bucket.key]
              if (rows.length === 0) return null
              return (
                <div key={bucket.key} className="mb-4 last:mb-0">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', bucket.dot)} />
                    <span className={cn('text-[11px] font-medium', bucket.text)}>{bucket.label}</span>
                    <span className="text-[10px] text-gray-400">({rows.length})</span>
                  </div>
                  <p className="mb-1.5 text-[10px] leading-snug text-gray-500">{bucket.note}</p>

                  <div className="rounded-xl border border-[#E8E6E1] bg-white">
                    {rows.map((s) => {
                      const id = String(s.timeslot_id)
                      const { date, range, nextDay } = slotRange(s)
                      // Copied this session but not yet re-synced, so the
                      // server's occupancy guard still reads it as free —
                      // see consumedSlotIds in FlashDeals.
                      const consumed = consumedSlotIds.has(id)
                      const checked = picked.has(id)
                      const blocked = consumed || (!checked && atCap)

                      return (
                        <label
                          key={id}
                          className={cn(
                            'flex items-center gap-2.5 border-b border-[#ECECEC] px-3 py-3 last:border-b-0',
                            blocked ? 'opacity-45' : 'cursor-pointer active:bg-[#F3F4F6]',
                            checked && 'bg-[#2563EB]/5'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={blocked}
                            onChange={(e) => toggle(id, e.target.checked)}
                            className="h-5 w-5 shrink-0 rounded border-[#E8E6E1] accent-[#2563EB] disabled:cursor-not-allowed"
                          />
                          <span className={cn('h-2 w-2 shrink-0 rounded-full', bucket.dot)} />
                          <span className="text-xs tabular-nums text-[#1F2937]">{date}</span>
                          <span className="text-xs tabular-nums text-[#1F2937]">{range}</span>
                          {nextDay && (
                            <span className="rounded bg-[#F3F4F6] px-1 text-[10px] text-gray-500">
                              +1
                            </span>
                          )}
                          {consumed && (
                            <span className="ml-auto shrink-0 text-[10px] text-gray-500">
                              just copied
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="border-t border-[#E8E6E1] bg-white px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-[#6B7280]">
              {picked.size} of {COPY_MAX_SLOTS} selected
            </span>
            {picked.size > COPY_MAX_PER_WINDOW && (
              <span className="text-[10px] text-[#6B7280]">
                ~{formatDuration(estMs)} — {COPY_MAX_PER_WINDOW}/min rate limit
              </span>
            )}
          </div>
          {atCap && (
            <p className="mb-2 text-[10px] text-gray-500">
              {COPY_MAX_SLOTS} is the cap — the batch runs in this screen, and more would mean
              waiting here far longer.
            </p>
          )}
          <button
            type="button"
            onClick={() => onConfirm([...picked])}
            disabled={picked.size === 0}
            className={cn(
              'w-full rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
              picked.size === 0
                ? 'cursor-not-allowed bg-[#F3F4F6] text-gray-400'
                : 'bg-[#2563EB] text-white active:bg-[#2563EB]/90'
            )}
          >
            Confirm {picked.size > 0 ? `${picked.size} slot${picked.size === 1 ? '' : 's'}` : 'slots'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Copy screen. Order is: choose slots (via the popup above) → review the chosen
 * slots and the items that will be written → confirm for real.
 *
 * The free-slot list is every slot in the cached ~18-day horizon minus those
 * that already hold a session for THIS store, minus any consumed earlier in
 * this page's life.
 */
function CopySheet({
  open,
  sale,
  items,
  itemsLoading,
  onClose,
  onConfirm,
  onStop,
  copying,
  entries,
  consumedSlotIds,
  nowMs,
  tickMs,
}) {
  const [slots, setSlots] = useState(null)
  const [chosen, setChosen] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)
  // Bumped on every open so the picker remounts and re-seeds its checkboxes.
  // Not bumped on close, so the close animation still plays.
  const [pickerSeq, setPickerSeq] = useState(0)

  // Keyed on the sale's ID, NOT the sale object: a batch ends with fetchAll(),
  // which rebuilds `sales` and hands this component a fresh object for the same
  // session. Depending on identity would re-run this effect at that moment and
  // silently clear the slots the user just picked, right as the results appear.
  const saleId = sale?.id ?? null
  const storeId = sale?.store_id ?? null

  useEffect(() => {
    if (!open || !saleId) return
    let cancelled = false

    ;(async () => {
      setSlots(null)
      setChosen([])
      setPickerOpen(false)
      const nowIso = new Date().toISOString()
      const [{ data: allSlots }, { data: taken }] = await Promise.all([
        selectAllPaged('flashDeals.slots', (from, to) =>
          supabase
            .from('flash_sale_slots')
            .select('timeslot_id, start_time, end_time')
            .gt('start_time', nowIso)
            .order('start_time')
            .range(from, to)
        ),
        supabase.from('flash_sales').select('timeslot_id').eq('store_id', storeId),
      ])
      if (cancelled) return
      // Occupancy is per-store: another shop holding this slot is irrelevant.
      const takenIds = new Set((taken ?? []).map((t) => String(t.timeslot_id)))
      setSlots((allSlots ?? []).filter((s) => !takenIds.has(String(s.timeslot_id))))
    })()

    return () => {
      cancelled = true
    }
  }, [open, saleId, storeId])

  const enabled = useMemo(() => (items ?? []).filter((i) => i.status === 1), [items])
  const itemIds = useMemo(() => new Set(enabled.map((i) => i.item_id)), [enabled])

  const slotsById = useMemo(
    () => new Map((slots ?? []).map((s) => [String(s.timeslot_id), s])),
    [slots]
  )
  // Chronological regardless of the order they were ticked, so the batch runs
  // soonest-first — if it gets interrupted, the slots that mattered most are
  // the ones already done.
  const chosenSlots = useMemo(
    () =>
      chosen
        .map((id) => slotsById.get(id))
        .filter(Boolean)
        .sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    [chosen, slotsById]
  )

  const canConfirm = COPY_ENABLED && chosenSlots.length > 0 && !copying && enabled.length > 0
  const done = entries.length > 0 && !copying

  return (
    <Sheet
      open={open}
      // Not dismissable mid-batch: the sequencing loop lives in this page, so
      // closing here would abandon whichever slots haven't been attempted yet.
      onOpenChange={(o) => !o && !copying && onClose()}
    >
      <SheetContent
        side="bottom"
        showCloseButton={!copying}
        className="!h-screen w-full gap-0 rounded-t-2xl border-[#E8E6E1] bg-white p-0"
      >
        <SheetHeader className="border-b border-[#E8E6E1] px-4 py-4 pr-12">
          <SheetTitle className="text-[#1F2937]">Copy to free slots</SheetTitle>
          {sale && (
            <p className="text-xs text-[#6B7280]">
              From {slotLabel(sale)} · {sale.stores?.shop_name}
            </p>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {!COPY_ENABLED && (
            <div className="mt-3 rounded-xl border border-yellow-300 bg-yellow-50 p-3">
              <p className="text-xs text-yellow-900">
                ⏸️ Copy is disabled. This is a preview of what would be written — nothing is sent to
                Shopee. Pending the 2 Aug slot-ownership test.
              </p>
            </div>
          )}

          {/* ------------------- 1. choose the slots ------------------- */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => {
                setPickerSeq((n) => n + 1)
                setPickerOpen(true)
              }}
              disabled={copying || slots === null}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors',
                copying || slots === null
                  ? 'cursor-not-allowed bg-[#F3F4F6] text-gray-400'
                  : chosenSlots.length > 0
                    ? 'border border-[#2563EB]/30 bg-[#2563EB]/5 text-[#2563EB] active:bg-[#2563EB]/10'
                    : 'bg-[#2563EB] text-white active:bg-[#2563EB]/90'
              )}
            >
              <CalendarClock className="h-4 w-4 shrink-0" />
              {slots === null
                ? 'Loading slots…'
                : chosenSlots.length === 0
                  ? 'Choose Time Slot'
                  : `Change slots (${chosenSlots.length})`}
            </button>

            {chosenSlots.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {chosenSlots.map((s) => {
                  const id = String(s.timeslot_id)
                  const risk = slotRisk(s, nowMs)
                  const bucket = RISK_BUCKETS.find((b) => b.key === risk)
                  return (
                    <span
                      key={id}
                      className="flex items-center gap-1.5 rounded-full border border-[#E8E6E1] bg-white py-1 pl-2 pr-1 text-[11px] tabular-nums text-[#1F2937]"
                    >
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', bucket.dot)} />
                      {slotLabel(s)}
                      <button
                        type="button"
                        onClick={() => setChosen((prev) => prev.filter((c) => c !== id))}
                        disabled={copying}
                        aria-label={`Remove ${slotLabel(s)}`}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-400 active:bg-[#F3F4F6] disabled:opacity-40"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {chosenSlots.some((s) => slotRisk(s, nowMs) === 'near') && (
              <p className="mt-2 text-[11px] leading-snug text-yellow-800">
                ⚠️ Some picks start within 48h. Whether Shopee lets us hold a slot BigSeller also
                wants is still unobserved — the 2 Aug test hasn&apos;t run yet.
              </p>
            )}
          </div>

          {/* ------------------- per-slot outcomes ------------------- */}
          {entries.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-[#1F2937]">
                {copying ? 'Copying…' : 'Results'} · {entries.length} slot
                {entries.length === 1 ? '' : 's'}
              </p>
              <div className="space-y-2">
                {entries.map((e) => (
                  <CopySlotResult key={e.timeslotId} entry={e} tickMs={tickMs} />
                ))}
              </div>
            </div>
          )}

          {/* -------------------- what would be copied -------------------- */}
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-[#1F2937]">
              {done ? 'Copied' : 'Will copy'} {itemIds.size} item{itemIds.size === 1 ? '' : 's'} /{' '}
              {enabled.length} variant{enabled.length === 1 ? '' : 's'}, prices unchanged
              {chosenSlots.length > 1 && `, into each of ${chosenSlots.length} slots`}
            </p>
            <p className="mb-2 text-[11px] text-gray-500">
              Disabled and rejected variants are skipped. Prices are copied exactly — re-running a
              price is the case proven not to trip Shopee&apos;s lowest-price rule.
            </p>

            {itemsLoading ? (
              <div className="space-y-1.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full rounded-lg" />
                ))}
              </div>
            ) : enabled.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-400">
                No enabled variants on this session — nothing to copy.
              </p>
            ) : (
              <div className="rounded-xl border border-[#E8E6E1] bg-white shadow-card">
                {enabled.map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center gap-2 border-b border-[#ECECEC] px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-[#1F2937]">{i.item_name ?? 'Untitled'}</p>
                      <p className="truncate text-[10px] text-gray-500">{i.model_name ?? '—'}</p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-[#EE4D2D]">
                      RM {Number(i.input_promotion_price).toFixed(2)}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-gray-400">
                      ×{i.campaign_stock ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        <div className="border-t border-[#E8E6E1] bg-white px-4 py-3">
          {copying ? (
            <button
              type="button"
              onClick={onStop}
              className="w-full rounded-xl border border-[#E8E6E1] px-4 py-2.5 text-sm font-medium text-[#6B7280] active:bg-[#F3F4F6]"
            >
              Stop after the current slot
            </button>
          ) : done ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl bg-[#2563EB] px-4 py-2.5 text-sm font-medium text-white active:bg-[#2563EB]/90"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => onConfirm(sale, chosenSlots)}
              title={COPY_ENABLED ? undefined : COPY_DISABLED_HINT}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
                !canConfirm
                  ? 'cursor-not-allowed bg-[#F3F4F6] text-gray-400'
                  : 'bg-[#2563EB] text-white active:bg-[#2563EB]/90'
              )}
            >
              <Check className="h-4 w-4 shrink-0" />
              {!COPY_ENABLED
                ? 'Copy disabled'
                : chosenSlots.length === 0
                  ? 'Choose a slot first'
                  : `Create ${chosenSlots.length} flash deal${chosenSlots.length === 1 ? '' : 's'}`}
            </button>
          )}
          {copying && (
            <p className="mt-1.5 text-center text-[10px] text-gray-500">
              Keep this screen open — the batch runs here, not on the server.
            </p>
          )}
        </div>
      </SheetContent>

      <SlotPickerDialog
        key={pickerSeq}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        slots={slots}
        consumedSlotIds={consumedSlotIds}
        selected={chosen}
        nowMs={nowMs}
        onConfirm={(ids) => {
          setChosen(ids)
          setPickerOpen(false)
        }}
      />
    </Sheet>
  )
}

export default function FlashDeals() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('ongoing')
  const [openSaleId, setOpenSaleId] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [copySaleId, setCopySaleId] = useState(null)
  // One entry per slot in the running/finished batch. Never collapsed into a
  // single verdict — see CopySlotResult.
  const [copyEntries, setCopyEntries] = useState([])
  const [copying, setCopying] = useState(false)
  // Slots this page has already spent in a batch. The server's occupancy guard
  // reads flash_sales, which the copy path does NOT write — a new session only
  // lands there after the next sync. Without this, reopening the picker offers
  // a just-filled slot as free and a second copy would create a DUPLICATE
  // session on Shopee that nothing server-side can catch.
  const [consumedSlotIds, setConsumedSlotIds] = useState(() => new Set())
  const copyStopRef = useRef(false)
  // 1s clock, live only during a batch, so per-slot wait countdowns tick
  // without making the whole page re-render every second the rest of the time.
  const [tickMs, setTickMs] = useState(() => Date.now())
  const [itemsBySale, setItemsBySale] = useState({})
  const [loadingItemsFor, setLoadingItemsFor] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [syncingId, setSyncingId] = useState(null)
  // MOCK ONLY — see AutoRenewRow. Nothing reads this but the switches
  // themselves, and it resets on reload.
  const [autoRenewBySale, setAutoRenewBySale] = useState({})

  // Re-render every 30s so countdowns stay honest without refetching.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!copying) return
    const id = setInterval(() => setTickMs(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [copying])

  // The batch has no server-side queue behind it, so a reload mid-run simply
  // loses the slots that haven't been attempted yet.
  useEffect(() => {
    if (!copying) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [copying])

  // Sessions only — no variant rows. Item detail is fetched per-session on
  // demand (see the effect below).
  const fetchAll = useCallback(async () => {
    setLoading(true)
    // Paged: ~44 sessions per store under the 7-day retention window, so this
    // scales with store count and would reach the cap at ~23 stores.
    const { data, error } = await selectAllPaged('flashDeals.sessions', (from, to) =>
      supabase.from('flash_sales').select(SESSION_SELECT).order('start_time', { ascending: false }).range(from, to)
    )

    if (error) {
      console.error('[flash-deals] load failed', error)
      setSales([])
    } else {
      setSales(data ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll()
  }, [fetchAll])

  // Lazy-load variants for whichever session needs them — the inline expander,
  // the detail sheet, or the copy preview all share one cache keyed on session
  // id, so switching between them never refetches.
  const wantItemsFor = expandedId ?? openSaleId ?? copySaleId

  useEffect(() => {
    if (!wantItemsFor || itemsBySale[wantItemsFor]) return
    let cancelled = false

    ;(async () => {
      setLoadingItemsFor(wantItemsFor)
      // Paged: one session held 239 variant rows in live data — comfortably
      // under the cap, but this is exactly the shape that grew past it server
      // side, so it is bounded explicitly rather than by assumption.
      const { data, error } = await selectAllPaged('flashDeals.items', (from, to) =>
        supabase.from('flash_sale_items').select(ITEM_SELECT).eq('flash_sale_row_id', wantItemsFor).range(from, to)
      )

      if (cancelled) return
      if (error) console.error('[flash-deals] item load failed', error)
      setItemsBySale((prev) => ({ ...prev, [wantItemsFor]: data ?? [] }))
      setLoadingItemsFor(null)
    })()

    return () => {
      cancelled = true
    }
  }, [wantItemsFor, itemsBySale])

  // Per-slot on-demand refresh. Hits the same fetch/persist path the cron uses
  // (syncOneFlashSale), then reloads this one session's rows.
  const handleSyncSession = useCallback(async (sale) => {
    setSyncingId(sale.id)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        toast.error('You must be logged in to sync.')
        return
      }

      const res = await fetch(apiUrl('/api/shopee/sync?type=flash-sale'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flash_sale_row_id: sale.id }),
      })
      const data = await res.json()

      if (!res.ok) {
        // 429 carries retryAfterMs from whichever throttle layer fired, so the
        // message can be specific instead of a generic failure.
        if (res.status === 429 && data.retryAfterMs) {
          toast.error(`${data.error} Try again in ${Math.ceil(data.retryAfterMs / 1000)}s.`)
        } else {
          toast.error(data.error ?? 'Refresh failed.')
        }
        return
      }

      const [{ data: freshSale }, { data: freshItems }] = await Promise.all([
        supabase.from('flash_sales').select(SESSION_SELECT).eq('id', sale.id).maybeSingle(),
        selectAllPaged('flashDeals.items.resync', (from, to) =>
          supabase.from('flash_sale_items').select(ITEM_SELECT).eq('flash_sale_row_id', sale.id).range(from, to)
        ),
      ])

      if (freshSale) setSales((prev) => prev.map((s) => (s.id === sale.id ? freshSale : s)))
      setItemsBySale((prev) => ({ ...prev, [sale.id]: freshItems ?? [] }))
      toast.success(`Refreshed — ${data.enabledItemCount} item(s), ${data.models} variant(s).`)
    } catch (err) {
      console.error('[flash-deals] session sync failed', err)
      toast.error(describeRequestError(err, 'Refresh failed.'))
    } finally {
      setSyncingId(null)
    }
  }, [])

  const patchEntry = useCallback((timeslotId, next) => {
    setCopyEntries((prev) => prev.map((e) => (e.timeslotId === timeslotId ? { ...e, ...next } : e)))
  }, [])

  /**
   * Runs one slot to a verdict, retrying only the two refusals that are
   * genuinely transient. Returns the entry patch describing how it ended.
   *
   * `submissions` is shared across the batch and mutated here: a timestamp is
   * pushed before each request and POPPED again when the server refused before
   * logSyncStart, because those refusals write no sync_logs row and so spend no
   * rate budget. Getting that wrong would make the client pace against attempts
   * that never counted.
   */
  const copyOneSlot = useCallback(
    async (sale, slot, accessToken, submissions) => {
      const id = String(slot.timeslot_id)
      let rateRetries = 0
      let lockWaited = 0

      while (true) {
        if (copyStopRef.current) return { state: 'skipped' }

        const wait = rateWaitMs(submissions, Date.now())
        if (wait > 0) {
          patchEntry(id, { state: 'waiting', waitReason: 'rate', waitUntil: Date.now() + wait })
          await sleepUntil(Date.now() + wait, copyStopRef)
          continue
        }

        patchEntry(id, { state: 'running', waitReason: null, waitUntil: null })

        let res
        let data
        try {
          res = await fetch(apiUrl('/api/shopee/copy-flash-sale'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ source_row_id: sale.id, timeslot_id: slot.timeslot_id }),
          })
          submissions.push(Date.now())
          data = await res.json()
        } catch (err) {
          // Covers a dropped connection AND a platform hard-timeout, whose
          // non-JSON body fails the parse. Either way the create may have
          // reached Shopee, so this is never reported as a clean failure.
          console.error('[flash-deals] copy request failed', id, err)
          return { state: 'done', error: describeRequestError(err, 'Network error'), uncertain: true }
        }

        // These three are refused ahead of logSyncStart, so no sync_logs row
        // exists and the budget was not spent — take the timestamp back.
        const refusal = data?.reason
        if (refusal === 'rate_limited' || refusal === 'locked' || refusal === 'rate_limiter_unavailable') {
          submissions.pop()
        }

        if (refusal === 'locked') {
          if (lockWaited >= LOCK_MAX_WAIT_MS) {
            return {
              state: 'done',
              error:
                'Another copy held this store’s lock for over 90s — it was probably killed mid-flight. This slot was never attempted; retry it.',
            }
          }
          const pause = Math.max(LOCK_POLL_MS, Number(data.retryAfterMs) || 0)
          lockWaited += pause
          patchEntry(id, { state: 'waiting', waitReason: 'lock', waitUntil: Date.now() + pause })
          await sleepUntil(Date.now() + pause, copyStopRef)
          continue
        }

        if (refusal === 'rate_limited' || refusal === 'rate_limiter_unavailable') {
          if (rateRetries >= RATE_MAX_RETRIES) {
            return { state: 'done', error: `${data.error} This slot was never attempted; retry it.` }
          }
          rateRetries += 1
          const pause = (Number(data.retryAfterMs) || COPY_WINDOW_MS) + COPY_WINDOW_MARGIN_MS
          patchEntry(id, { state: 'waiting', waitReason: 'rate', waitUntil: Date.now() + pause })
          await sleepUntil(Date.now() + pause, copyStopRef)
          continue
        }

        // A body carrying `status` is the read-back diff's verdict — partial
        // and unverified included. HTTP status is not the signal here, and
        // success is never inferred from the write call.
        if (data?.status) return { state: 'done', result: data }

        // copy-flash-sale only 502s when copyFlashSale threw, which happens at
        // or before create_shop_flash_sale — so no session exists to be unsure
        // about.
        return {
          state: 'done',
          error: data?.error ?? `Copy failed (HTTP ${res.status})`,
        }
      }
    },
    [patchEntry]
  )

  /**
   * Copies one session into N slots. Each slot gets its own request, its own
   * sync_logs row and its own verdict — a failure on one is recorded and the
   * batch moves on, never rolling back or blocking a slot that worked.
   *
   * Unreachable while COPY_ENABLED is false — the button and the confirm are
   * both disabled — but written so flipping the two flags is the only step.
   */
  const handleCopyBatch = useCallback(
    async (sale, slots) => {
      if (!COPY_ENABLED || !sale || slots.length === 0) return

      copyStopRef.current = false
      setTickMs(Date.now())
      setCopyEntries(
        slots.map((s) => ({
          timeslotId: String(s.timeslot_id),
          label: slotLabel(s),
          state: 'queued',
          waitReason: null,
          waitUntil: null,
          result: null,
          error: null,
          uncertain: false,
        }))
      )
      setCopying(true)

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session) {
          toast.error('You must be logged in to copy.')
          setCopyEntries([])
          return
        }

        const submissions = []
        const consumed = []
        const tally = { success: 0, partial: 0, unverified: 0, failed: 0, skipped: 0 }

        for (const slot of slots) {
          const id = String(slot.timeslot_id)

          if (copyStopRef.current) {
            patchEntry(id, { state: 'skipped' })
            tally.skipped += 1
            continue
          }

          const patch = await copyOneSlot(sale, slot, session.access_token, submissions)
          patchEntry(id, patch)

          if (patch.state === 'skipped') {
            tally.skipped += 1
            continue
          }

          const status = patch.result?.status
          if (status) tally[status] += 1
          else tally.failed += 1

          // A slot is spent if a session exists on it OR if we simply don't
          // know — offering an unknown slot again invites a duplicate.
          if (patch.result?.flashSaleId || patch.uncertain) consumed.push(id)
        }

        if (consumed.length > 0) {
          setConsumedSlotIds((prev) => new Set([...prev, ...consumed]))
        }

        // A summary line, never a verdict — the per-slot list is the answer and
        // stays on screen. Refetch once, not per slot.
        const parts = [
          tally.success && `${tally.success} copied`,
          tally.partial && `${tally.partial} partial`,
          tally.unverified && `${tally.unverified} unverified`,
          tally.failed && `${tally.failed} failed`,
          tally.skipped && `${tally.skipped} skipped`,
        ].filter(Boolean)

        if (tally.success === slots.length) toast.success(`${tally.success} slot(s) copied.`)
        else toast.error(`${parts.join(', ')} — see the per-slot results.`)

        if (tally.success + tally.partial + tally.unverified > 0) fetchAll()
      } catch (err) {
        console.error('[flash-deals] copy batch failed', err)
        toast.error('Copy batch failed.')
      } finally {
        copyStopRef.current = false
        setCopying(false)
      }
    },
    [copyOneSlot, patchEntry, fetchAll]
  )

  const grouped = useMemo(() => {
    const out = { ongoing: [], upcoming: [], expired: [] }
    for (const sale of sales) out[liveState(sale, nowMs)].push(sale)
    // Upcoming reads best soonest-first; the query sorts newest-first, which is
    // right for ongoing and expired.
    out.upcoming.reverse()
    return out
  }, [sales, nowMs])

  const openSale = sales.find((s) => s.id === openSaleId) ?? null
  const copySale = sales.find((s) => s.id === copySaleId) ?? null

  const sortItems = useCallback(
    (rows) =>
      [...(rows ?? [])].sort(
        (a, b) =>
          (b.status === 1) - (a.status === 1) ||
          (a.item_name ?? '').localeCompare(b.item_name ?? '') ||
          (a.model_name ?? '').localeCompare(b.model_name ?? '')
      ),
    []
  )

  const openItems = useMemo(
    () => (openSale ? sortItems(itemsBySale[openSale.id]) : []),
    [openSale, itemsBySale, sortItems]
  )
  const rejectedCount = openItems.filter((i) => i.status === 4 || i.status === 5).length
  const visible = grouped[tab] ?? []

  const toggleSelect = useCallback((id, next) => {
    setSelectedIds((prev) => {
      const out = new Set(prev)
      if (next) out.add(id)
      else out.delete(id)
      return out
    })
  }, [])

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-[#1F2937]">⚡ Flash Deals</h1>
        <p className="text-sm text-[#6B7280]">Shopee flash sale sessions</p>
      </header>

      <div className="mx-4 my-3 rounded-2xl border border-[#2563EB]/30 bg-[#2563EB]/10 p-3">
        <p className="text-xs text-[#2563EB]">
          ℹ️ Monitoring only. BigSeller creates and fills these slots — MyStore Hub reads them so you
          can watch prices, quotas and timing in one place. Shopee doesn&apos;t report units sold, so
          quota is the allocated amount, not stock left.
        </p>
      </div>

      <div className="px-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3 bg-[#F3F4F6]">
            <TabsTrigger value="ongoing">Live ({grouped.ongoing.length})</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming ({grouped.upcoming.length})</TabsTrigger>
            <TabsTrigger value="expired">Ended ({grouped.expired.length})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {selectedIds.size > 0 && (
        <div className="mx-4 mt-3 flex items-center justify-between rounded-xl border border-[#2563EB]/30 bg-[#2563EB]/5 px-3 py-2">
          <span className="text-xs text-[#2563EB]">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-[#2563EB] underline"
          >
            Clear
          </button>
        </div>
      )}

      <div className="mt-3 px-4">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="mt-8 text-center text-sm text-gray-500">
            {sales.length === 0
              ? 'No flash sale data yet — it appears after the next sync.'
              : `No ${tab === 'ongoing' ? 'live' : tab} sessions.`}
          </p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[#E8E6E1] bg-white shadow-card">
            {/* Column headers exist only where the table layout does. */}
            <div
              className={cn(
                'hidden items-center gap-3 border-b border-[#E8E6E1] bg-[#FAF9F6] px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 md:grid',
                GRID_COLS
              )}
            >
              <span />
              <span>Time slot</span>
              <span>Flash sale ID</span>
              <span>Items</span>
              <span>Clicks</span>
              <span>Remind</span>
              <span>Status</span>
              <span>Renew</span>
              <span className="text-right">Actions</span>
            </div>

            {visible.map((sale) => (
              <div key={sale.id}>
                <SessionRow
                  sale={sale}
                  state={liveState(sale, nowMs)}
                  nowMs={nowMs}
                  selected={selectedIds.has(sale.id)}
                  onSelect={(next) => toggleSelect(sale.id, next)}
                  expanded={expandedId === sale.id}
                  onToggleExpand={() => setExpandedId((prev) => (prev === sale.id ? null : sale.id))}
                  syncing={syncingId === sale.id}
                  onSync={handleSyncSession}
                  onCopy={(s) => {
                    setCopyEntries([])
                    setCopySaleId(s.id)
                  }}
                  onDetails={(s) => setOpenSaleId(s.id)}
                  autoRenew={!!autoRenewBySale[sale.id]}
                  onAutoRenew={(next) =>
                    setAutoRenewBySale((prev) => ({ ...prev, [sale.id]: next }))
                  }
                />

                {expandedId === sale.id && (
                  <div className="border-b border-[#E8E6E1] bg-[#FAF9F6] px-3 py-2">
                    {loadingItemsFor === sale.id ? (
                      <div className="space-y-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <Skeleton key={i} className="h-14 w-full rounded-lg" />
                        ))}
                      </div>
                    ) : (itemsBySale[sale.id] ?? []).length === 0 ? (
                      <p className="py-3 text-center text-xs text-gray-400">
                        No item data synced for this session yet.
                      </p>
                    ) : (
                      sortItems(itemsBySale[sale.id]).map((item) => (
                        <ItemRow key={item.id} item={item} />
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Existing detail sheet, unchanged in structure. */}
      <Sheet open={!!openSale} onOpenChange={(open) => !open && setOpenSaleId(null)}>
        <SheetContent
          side="bottom"
          className="!h-screen w-full gap-0 rounded-t-2xl border-[#E8E6E1] bg-white p-0"
        >
          {/* pr-12 keeps the header clear of the sheet's own close X, which is
              absolutely positioned at top-3 right-3 (see ui/sheet.jsx). */}
          <SheetHeader className="border-b border-[#E8E6E1] px-4 py-4 pr-12">
            <SheetTitle className="text-[#1F2937]">
              {openSale ? slotLabel(openSale) : 'Session'}
            </SheetTitle>
            {openSale && (
              <p className="text-xs text-[#6B7280]">
                {openSale.stores?.shop_name} ·{' '}
                <Countdown sale={openSale} state={liveState(openSale, nowMs)} nowMs={nowMs} />
              </p>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 pb-8">
            {openSale && (
              <div className="flex gap-4 border-b border-[#ECECEC] py-3 text-xs text-[#6B7280]">
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" /> {openSale.click_count ?? 0} clicks
                </span>
                <span className="flex items-center gap-1">
                  <Bell className="h-3.5 w-3.5" /> {openSale.remindme_count ?? 0} reminders
                </span>
                <span>{openItems.length} variants</span>
              </div>
            )}
            {openSale && <SessionDetails sale={openSale} nowMs={nowMs} />}
            {openSale && (
              <AutoRenewRow
                enabled={!!autoRenewBySale[openSale.id]}
                onChange={(next) =>
                  setAutoRenewBySale((prev) => ({ ...prev, [openSale.id]: next }))
                }
              />
            )}
            {loadingItemsFor === openSaleId ? (
              <div className="space-y-2 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : openItems.length === 0 ? (
              <p className="py-8 text-center text-xs text-gray-400">
                No item data synced for this session yet.
              </p>
            ) : (
              <>
                {rejectedCount > 0 && (
                  <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-yellow-300 bg-yellow-50 px-2 py-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-600" />
                    <span className="text-[11px] text-yellow-800">
                      {rejectedCount} variant(s) rejected by Shopee
                    </span>
                  </div>
                )}
                {openItems.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <CopySheet
        open={!!copySale}
        sale={copySale}
        items={copySale ? itemsBySale[copySale.id] : []}
        itemsLoading={loadingItemsFor === copySaleId}
        onClose={() => setCopySaleId(null)}
        onConfirm={handleCopyBatch}
        onStop={() => {
          copyStopRef.current = true
        }}
        copying={copying}
        entries={copyEntries}
        consumedSlotIds={consumedSlotIds}
        nowMs={nowMs}
        tickMs={tickMs}
      />
    </div>
  )
}
