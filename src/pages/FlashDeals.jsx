import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronRight,
  Copy as CopyIcon,
  Eye,
  Package,
  RefreshCw,
  Repeat,
} from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'

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
 * Renders a copy's outcome. Success is NEVER inferred from the write call —
 * add_shop_flash_sale_items returns an empty body — so everything here comes
 * from the server's read-back diff, and anything short of an exact match is
 * shown as PARTIAL with the offending models named.
 */
function CopyResult({ result }) {
  if (!result) return null
  const ok = result.status === 'success'

  return (
    <div
      className={cn(
        'rounded-xl border p-3 text-xs',
        ok ? 'border-green-200 bg-green-50' : 'border-yellow-300 bg-yellow-50'
      )}
    >
      <p className={cn('font-medium', ok ? 'text-green-800' : 'text-yellow-900')}>
        {ok
          ? `Copied — ${result.persistedCount}/${result.sentCount} models verified`
          : `${result.status === 'unverified' ? 'UNVERIFIED' : 'PARTIAL'} — ${result.persistedCount ?? '?'}/${result.sentCount} models verified`}
      </p>
      <p className="mt-1 text-[11px] text-gray-600">
        New flash sale <span className="font-mono">{result.flashSaleId}</span> on slot{' '}
        <span className="font-mono">{result.timeslotId}</span>
      </p>

      {result.addError && (
        <p className="mt-1.5 text-[11px] text-red-700">Add call reported: {result.addError}</p>
      )}
      {result.readBackError && (
        <p className="mt-1.5 text-[11px] text-red-700">
          Read-back failed: {result.readBackError}. What landed is unknown — inspect the session on
          Shopee before retrying.
        </p>
      )}

      {result.missing?.length > 0 && (
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

      {result.priceMismatches?.length > 0 && (
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

      {result.stockMismatches?.length > 0 && (
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

      {result.rejected?.length > 0 && (
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
 * Copy target picker. Lists FREE upcoming slots — every slot in the cached
 * ~18-day horizon minus those that already hold a session for THIS store —
 * and shows exactly what would be written, at what prices.
 */
function CopySheet({ open, sale, items, itemsLoading, onClose, onConfirm, copying, result }) {
  const [slots, setSlots] = useState(null)
  const [chosen, setChosen] = useState(null)

  useEffect(() => {
    if (!open || !sale) return
    let cancelled = false

    ;(async () => {
      setSlots(null)
      setChosen(null)
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
        supabase.from('flash_sales').select('timeslot_id').eq('store_id', sale.store_id),
      ])
      if (cancelled) return
      // Occupancy is per-store: another shop holding this slot is irrelevant.
      const takenIds = new Set((taken ?? []).map((t) => String(t.timeslot_id)))
      setSlots((allSlots ?? []).filter((s) => !takenIds.has(String(s.timeslot_id))))
    })()

    return () => {
      cancelled = true
    }
  }, [open, sale])

  const enabled = useMemo(() => (items ?? []).filter((i) => i.status === 1), [items])
  const itemIds = useMemo(() => new Set(enabled.map((i) => i.item_id)), [enabled])

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="!h-screen w-full gap-0 rounded-t-2xl border-[#E8E6E1] bg-white p-0"
      >
        <SheetHeader className="border-b border-[#E8E6E1] px-4 py-4 pr-12">
          <SheetTitle className="text-[#1F2937]">Copy to a free slot</SheetTitle>
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

          {result && (
            <div className="mt-3">
              <CopyResult result={result} />
            </div>
          )}

          {/* -------------------- what would be copied -------------------- */}
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-[#1F2937]">
              Will copy {itemIds.size} item{itemIds.size === 1 ? '' : 's'} / {enabled.length} variant
              {enabled.length === 1 ? '' : 's'}, prices unchanged
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

          {/* ------------------------- free slots ------------------------- */}
          <div className="mt-5">
            <p className="mb-1.5 text-xs font-medium text-[#1F2937]">Choose a free slot</p>
            {slots === null ? (
              <div className="space-y-1.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : slots.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-400">
                No free slots in the 18-day horizon for this store.
              </p>
            ) : (
              <div className="rounded-xl border border-[#E8E6E1] bg-white shadow-card">
                {slots.map((s) => {
                  const { date, range, nextDay } = slotRange(s)
                  const active = chosen === s.timeslot_id
                  return (
                    <button
                      key={s.timeslot_id}
                      type="button"
                      onClick={() => setChosen(s.timeslot_id)}
                      className={cn(
                        'flex w-full items-center gap-2 border-b border-[#ECECEC] px-3 py-2.5 text-left last:border-b-0 transition-colors',
                        active ? 'bg-[#2563EB]/5' : 'hover:bg-[#F3F4F6]'
                      )}
                    >
                      <span
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 rounded-full border-2',
                          active ? 'border-[#2563EB] bg-[#2563EB]' : 'border-[#E8E6E1]'
                        )}
                      />
                      <span className="text-xs tabular-nums text-[#1F2937]">{date}</span>
                      <span className="text-xs tabular-nums text-[#1F2937]">{range}</span>
                      {nextDay && (
                        <span className="rounded bg-[#F3F4F6] px-1 text-[10px] text-gray-500">+1</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-[#E8E6E1] bg-white px-4 py-3">
          <button
            type="button"
            disabled={!COPY_ENABLED || !chosen || copying || enabled.length === 0}
            onClick={() => onConfirm(sale, chosen)}
            title={COPY_ENABLED ? undefined : COPY_DISABLED_HINT}
            className={cn(
              'w-full rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
              !COPY_ENABLED || !chosen || copying || enabled.length === 0
                ? 'cursor-not-allowed bg-[#F3F4F6] text-gray-400'
                : 'bg-[#2563EB] text-white active:bg-[#2563EB]/90'
            )}
          >
            {copying ? 'Copying…' : COPY_ENABLED ? 'Copy to selected slot' : 'Copy disabled'}
          </button>
        </div>
      </SheetContent>
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
  const [copyResult, setCopyResult] = useState(null)
  const [copying, setCopying] = useState(false)
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

      const res = await fetch('/api/shopee/sync-flash-sale', {
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
      toast.error('Refresh failed.')
    } finally {
      setSyncingId(null)
    }
  }, [])

  // Copy. Unreachable while COPY_ENABLED is false — the button and the confirm
  // are both disabled — but written so flipping the two flags is the only step.
  const handleCopy = useCallback(async (sale, timeslotId) => {
    if (!COPY_ENABLED) return
    setCopying(true)
    setCopyResult(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        toast.error('You must be logged in to copy.')
        return
      }

      const res = await fetch('/api/shopee/copy-flash-sale', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source_row_id: sale.id, timeslot_id: timeslotId }),
      })
      const data = await res.json()

      if (!res.ok && !data.status) {
        toast.error(data.error ?? 'Copy failed.')
        return
      }

      // Never infer success from the write call — the server's read-back diff
      // is the verdict, and it rides in the body even on a partial.
      setCopyResult(data)
      if (data.status === 'success') {
        toast.success(`Copied — ${data.persistedCount}/${data.sentCount} variants verified.`)
        fetchAll()
      } else {
        toast.error(`${data.status === 'unverified' ? 'Unverified' : 'Partial'} copy — see details.`)
      }
    } catch (err) {
      console.error('[flash-deals] copy failed', err)
      toast.error('Copy failed.')
    } finally {
      setCopying(false)
    }
  }, [fetchAll])

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
                    setCopyResult(null)
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
        onConfirm={handleCopy}
        copying={copying}
        result={copyResult}
      />
    </div>
  )
}
