import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, Eye, Package, Bell, RefreshCw, Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'

// READ-ONLY view of Shopee flash sale sessions. There is no create/edit path
// here by design: BigSeller currently owns slot creation on these shops, and
// MyStore Hub coexists as an observer. The per-slot Sync button is still part of
// that contract — it pulls fresh data, it never writes to Shopee.
//
// Deliberately NOT shown: "stock left" / "units sold". Shopee's
// get_shop_flash_sale_items exposes no such field — campaign_stock is the
// ALLOCATED quota and never decrements, and `stock` is the product's live stock
// rather than a campaign figure. Showing either as "left" would be a lie, so
// this page shows the quota, the prices, engagement, and the countdown only.

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
// be system-rejected while its items still read as enabled, which is exactly
// the case that used to be invisible on this page.
const SESSION_STATUS = {
  0: { label: 'Deleted', cls: 'bg-gray-100 text-gray-500' },
  1: { label: 'Enabled', cls: 'bg-green-100 text-green-700' },
  2: { label: 'Disabled', cls: 'bg-gray-100 text-gray-600' },
  3: { label: 'System rejected', cls: 'bg-red-100 text-red-700' },
}

// Server enforces a 60s per-session cooldown (SESSION_SYNC_COOLDOWN_MS in
// api/_lib/flashSaleSync.js). Mirrored here only to grey the button out; the
// endpoint is the thing that actually holds the line.
const SYNC_COOLDOWN_MS = 60_000

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

function slotLabel(sale) {
  const start = new Date(sale.start_time)
  const end = new Date(sale.end_time)
  const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = start.toLocaleDateString([], { day: '2-digit', month: 'short' })
  return `${day} · ${time(start)}–${time(end)}`
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

function SessionCard({ sale, state, nowMs, onOpen }) {
  // Counts come from the stored columns the sync derives from the ITEMS
  // endpoint, so the list query never has to pull variant rows — a 7-day window
  // across 4 stores is ~40k of them.
  const enabledItems = sale.enabled_item_count_derived
  const modelCount = sale.enabled_model_count

  return (
    <button
      onClick={() => onOpen(sale)}
      className="w-full rounded-xl border border-[#ECECEC] bg-white p-4 text-left shadow-sm transition-transform active:scale-[0.99]"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[#1F2937]">{slotLabel(sale)}</p>
          <p className="truncate text-xs text-[#6B7280]">{sale.stores?.shop_name ?? 'Store'}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
            state === 'ongoing' && 'bg-[#EE4D2D]/10 text-[#EE4D2D]',
            state === 'upcoming' && 'bg-blue-50 text-[#2563EB]',
            state === 'expired' && 'bg-gray-100 text-gray-500'
          )}
        >
          {state === 'ongoing' ? 'LIVE' : state === 'upcoming' ? 'Upcoming' : 'Ended'}
        </span>
      </div>

      <div className="mb-2 text-xs">
        <Countdown sale={sale} state={state} nowMs={nowMs} />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6B7280]">
          <span>
            {enabledItems ?? 0} item{enabledItems === 1 ? '' : 's'} · {modelCount ?? 0} variant
            {modelCount === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3" /> {sale.click_count ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <Bell className="h-3 w-3" /> {sale.remindme_count ?? 0}
          </span>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
      </div>
    </button>
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
    <div className="flex items-start gap-3 border-b border-[#ECECEC] py-3">
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
            surfaced. Only shown when it actually differs from the input price,
            so it stays quiet on the shops where tax is not applied. */}
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
        {item.reject_reason && (
          <p className="mt-1 text-[11px] text-red-600">{item.reject_reason}</p>
        )}
      </div>
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', status.cls)}>
        {status.label}
      </span>
    </div>
  )
}

function SyncButton({ sale, nowMs, syncing, onSync }) {
  // nowMs only ticks every 30s, so right after a sync it can still be BEHIND
  // observed_at — clamped at 0, otherwise the countdown briefly reads higher
  // than the cooldown itself (a 60s cooldown showing "63s").
  const since = Math.max(0, nowMs - new Date(sale.observed_at ?? 0).getTime())
  const cooling = since < SYNC_COOLDOWN_MS
  const secsLeft = Math.ceil((SYNC_COOLDOWN_MS - since) / 1000)

  return (
    <button
      type="button"
      onClick={() => onSync(sale)}
      disabled={syncing || cooling}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
        syncing || cooling
          ? 'border-[#ECECEC] bg-[#F3F4F6] text-gray-400'
          : 'border-[#EE4D2D]/30 bg-[#EE4D2D]/10 text-[#EE4D2D] active:bg-[#EE4D2D]/20'
      )}
    >
      <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
      {/* The countdown is cosmetic — the server enforces the same cooldown and
          answers 429 with its own retryAfterMs regardless of what's shown here.
          nowMs ticks every 30s, so this can lag by up to that much; it never
          re-enables the button earlier than the server would. */}
      {syncing ? 'Syncing…' : cooling ? `${secsLeft}s` : 'Sync'}
    </button>
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

// MOCK UI ONLY. No logic, no scheduling, no persistence — this exists so the
// layout can be judged before the real thing is built. It cannot renew anything:
// renewing means creating a flash sale on Shopee, and this app has no write path
// to Shopee at all (see the header comment and api/_lib/flashSaleSync.js).
// The label says so plainly rather than implying a feature that isn't there.
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

export default function FlashDeals() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('ongoing')
  const [openSaleId, setOpenSaleId] = useState(null)
  const [itemsBySale, setItemsBySale] = useState({})
  const [itemsLoading, setItemsLoading] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [syncingId, setSyncingId] = useState(null)
  // MOCK ONLY — see the AutoRenewRow comment. Kept in component state so the
  // toggle feels real while it is being designed; nothing reads this but the
  // switch itself, and it resets on reload.
  const [autoRenewBySale, setAutoRenewBySale] = useState({})

  // Re-render every 30s so countdowns stay honest without refetching.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Sessions only — no variant rows. Item detail is fetched per-session when a
  // sheet is opened (see the effect below).
  const fetchAll = useCallback(async () => {
    setLoading(true)
    // Paged: ~44 sessions per store under the 7-day retention window, so this
    // scales with store count and would reach the cap at ~23 stores.
    const { data, error } = await selectAllPaged('flashDeals.sessions', (from, to) =>
      supabase
        .from('flash_sales')
        .select(
          'id, store_id, flash_sale_id, timeslot_id, status, type, start_time, end_time, ' +
            'item_count, enabled_item_count_reported, enabled_item_count_derived, enabled_model_count, ' +
            'click_count, remindme_count, observed_at, stores(shop_name)'
        )
        .order('start_time', { ascending: false })
        .range(from, to)
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

  // Lazy-load the opened session's variants. Cached per session id so
  // reopening the same sheet doesn't refetch.
  useEffect(() => {
    if (!openSaleId || itemsBySale[openSaleId]) return
    let cancelled = false

    ;(async () => {
      setItemsLoading(true)
      // Paged: one session held 239 variant rows in live data — comfortably
      // under the cap, but this is exactly the shape that grew past it server
      // side, so it is bounded explicitly rather than by assumption.
      const { data, error } = await selectAllPaged('flashDeals.items', (from, to) =>
        supabase
          .from('flash_sale_items')
          .select(
            'id, item_id, model_id, item_name, model_name, image, status, original_price, ' +
              'input_promotion_price, promotion_price_with_tax, purchase_limit, campaign_stock, ' +
              'item_stock, reject_reason, products(image_url)'
          )
          .eq('flash_sale_row_id', openSaleId)
          .range(from, to)
      )

      if (cancelled) return
      if (error) {
        console.error('[flash-deals] item load failed', error)
      }
      setItemsBySale((prev) => ({ ...prev, [openSaleId]: data ?? [] }))
      setItemsLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [openSaleId, itemsBySale])

  // Per-slot on-demand refresh. Hits the same fetch/persist path the cron uses
  // (syncOneFlashSale), then reloads this one session's rows from Supabase
  // rather than re-running the whole page query.
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

      // Pull the freshly-written rows back. Both the session row and its items
      // change, and the items cache is keyed on session id, so it's replaced
      // outright rather than merged.
      const [{ data: freshSale }, { data: freshItems }] = await Promise.all([
        supabase
          .from('flash_sales')
          .select(
            'id, store_id, flash_sale_id, timeslot_id, status, type, start_time, end_time, ' +
              'item_count, enabled_item_count_reported, enabled_item_count_derived, enabled_model_count, ' +
              'click_count, remindme_count, observed_at, stores(shop_name)'
          )
          .eq('id', sale.id)
          .maybeSingle(),
        selectAllPaged('flashDeals.items.resync', (from, to) =>
          supabase
            .from('flash_sale_items')
            .select(
              'id, item_id, model_id, item_name, model_name, image, status, original_price, ' +
                'input_promotion_price, promotion_price_with_tax, purchase_limit, campaign_stock, ' +
                'item_stock, reject_reason, products(image_url)'
            )
            .eq('flash_sale_row_id', sale.id)
            .range(from, to)
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

  const grouped = useMemo(() => {
    const out = { ongoing: [], upcoming: [], expired: [] }
    for (const sale of sales) out[liveState(sale, nowMs)].push(sale)
    // Upcoming reads best soonest-first; the query sorts newest-first, which is
    // right for ongoing and expired.
    out.upcoming.reverse()
    return out
  }, [sales, nowMs])

  const openSale = sales.find((s) => s.id === openSaleId) ?? null
  const openItems = useMemo(() => {
    if (!openSale) return []
    return [...(itemsBySale[openSale.id] ?? [])].sort(
      (a, b) =>
        (b.status === 1) - (a.status === 1) ||
        (a.item_name ?? '').localeCompare(b.item_name ?? '') ||
        (a.model_name ?? '').localeCompare(b.model_name ?? '')
    )
  }, [openSale, itemsBySale])

  const rejectedCount = openItems.filter((i) => i.status === 4 || i.status === 5).length
  const visible = grouped[tab] ?? []

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-[#1F2937]">⚡ Flash Deals</h1>
        <p className="text-sm text-[#6B7280]">Shopee flash sale sessions</p>
      </header>

      <div className="mx-4 my-3 rounded-xl border border-[#2563EB]/30 bg-[#2563EB]/10 p-3">
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

      <div className="mt-3 flex flex-col gap-3 px-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)
        ) : visible.length === 0 ? (
          <p className="mt-8 text-center text-sm text-gray-500">
            {sales.length === 0
              ? 'No flash sale data yet — it appears after the next sync.'
              : `No ${tab === 'ongoing' ? 'live' : tab} sessions.`}
          </p>
        ) : (
          visible.map((sale) => (
            <SessionCard
              key={sale.id}
              sale={sale}
              state={liveState(sale, nowMs)}
              nowMs={nowMs}
              onOpen={(s) => setOpenSaleId(s.id)}
            />
          ))
        )}
      </div>

      <Sheet open={!!openSale} onOpenChange={(open) => !open && setOpenSaleId(null)}>
        <SheetContent
          side="bottom"
          className="!h-screen w-full gap-0 rounded-t-2xl border-[#ECECEC] bg-white p-0"
        >
          {/* pr-12 keeps the Sync button clear of the sheet's own close X, which
              is absolutely positioned at top-3 right-3 (see ui/sheet.jsx). */}
          <SheetHeader className="border-b border-[#ECECEC] px-4 py-4 pr-12">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="text-[#1F2937]">
                  {openSale ? slotLabel(openSale) : 'Session'}
                </SheetTitle>
                {openSale && (
                  <p className="text-xs text-[#6B7280]">
                    {openSale.stores?.shop_name} ·{' '}
                    <Countdown sale={openSale} state={liveState(openSale, nowMs)} nowMs={nowMs} />
                  </p>
                )}
              </div>
              {openSale && (
                <SyncButton
                  sale={openSale}
                  nowMs={nowMs}
                  syncing={syncingId === openSale.id}
                  onSync={handleSyncSession}
                />
              )}
            </div>
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
            {itemsLoading ? (
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
    </div>
  )
}
