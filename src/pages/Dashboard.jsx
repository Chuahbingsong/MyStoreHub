import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bell, ChevronRight, Flame, Printer, ScanLine, ShoppingBag, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { formatRelativeToNow } from '@/lib/i18n/datetime'
import { statusKeyFor } from '@/lib/orderStatus'
import {
  addDaysISO,
  countsAsRevenue,
  fetchActionableOrdersReport,
  figuresForDay,
  formatRM,
  seriesFor,
  todayKL,
} from '@/lib/salesReport'

const ORDER_COLUMNS =
  'id, store_id, platform, order_status, buyer_name, total_amount, order_created_at, platform_order_id'

// The recent-orders card shows 5. Fetched per store (not as one global limit)
// because the store filter is applied client-side — see fetchData.
const RECENT_ORDERS_PER_STORE = 5

const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
}

// Order of the platform breakdown grid + per-platform display styling.
const PLATFORM_DISPLAY = {
  Shopee: { dotClass: 'bg-orange-500', letter: 'S', badgeClass: 'bg-orange-500' },
  Lazada: { dotClass: 'bg-blue-500', letter: 'L', badgeClass: 'bg-blue-500' },
  TikTok: { dotClass: 'bg-gray-400', letter: 'T', badgeClass: 'bg-gray-500' },
  Shopify: { dotClass: 'bg-green-500', letter: 'SH', badgeClass: 'bg-green-600' },
}

const PLATFORM_ORDER = ['Shopee', 'Lazada', 'TikTok', 'Shopify']

// Shared pill style for status/connection badges — matches Orders' BADGE_CLS
// so the two pages read as one system.
const BADGE_CLS = 'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none'

// Raw order_status -> STABLE status key. This local map is gone: it duplicated
// (and, for UNPAID, DISAGREED with) the canonical mapping, which now lives in
// src/lib/orderStatus.js and is shared by Orders, Scan and this page.
//
// The disagreement it carried: UNPAID mapped to 'new' here and rendered as
// "New", while Orders gives UNPAID its own "Unpaid" tab. One raw status, two
// words, depending on which screen the seller was looking at. It now resolves
// to 'unpaid' everywhere. This was always a LABEL bug only — the To Pack stat
// below filters on READY_TO_SHIP and never counted unpaid orders.
//
// Rendering still goes through t('status.<key>'); STATUS_CLASS is keyed by the
// same stable keys, never by the display string (that was the original bug:
// translating a label would have dropped every badge to the default gray).
const STATUS_CLASS = {
  unpaid: 'bg-gray-200 text-gray-600',
  invoicePending: 'bg-orange-500/15 text-orange-600',
  toPack: 'bg-yellow-600/15 text-yellow-700',
  retryShipment: 'bg-orange-600/15 text-orange-700',
  toConfirmReceipt: 'bg-green-500/15 text-green-600',
  cancelRequested: 'bg-amber-500/15 text-amber-700',
  returnRequested: 'bg-amber-500/15 text-amber-700',
  returned: 'bg-amber-600/15 text-amber-800',
  packed: 'bg-yellow-600/15 text-yellow-700',
  shipped: 'bg-green-500/15 text-green-600',
  completed: 'bg-teal-500/15 text-teal-600',
  cancelled: 'bg-red-500/15 text-red-600',
}
const DEFAULT_STATUS_CLASS = 'bg-gray-500/15 text-gray-600'

function isToday(value) {
  if (!value) return false
  const d = new Date(value)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function formatRevenue(amount) {
  return `RM ${Math.round(amount).toLocaleString('en-MY')}`
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform
}

// Weekday/month names are language content (unlike RM amounts, which stay
// locale-invariant on purpose) — this is the one date on the page that's a
// full sentence rather than a short relative timestamp, so it's worth
// formatting properly per locale instead of always rendering in English.
function formatToday(locale) {
  const intlLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-GB'
  return new Date().toLocaleDateString(intlLocale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

// A stat tile, optionally a link. Same visual box either way so the strip
// stays a uniform row — the chevron is the only affordance difference.
function StatTile({ stat }) {
  const body = (
    <>
      <p className={cn('text-2xl font-bold tabular-nums', stat.valueClass)}>{stat.value}</p>
      <p className="mt-0.5 flex items-center gap-1 text-sm text-[#6B7280]">
        {stat.label}
        {stat.to && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#2563EB]" />}
      </p>
      {stat.sub && <p className="mt-1 text-xs tabular-nums text-[#6B7280]">{stat.sub}</p>}
    </>
  )

  const className =
    'min-w-[140px] shrink-0 rounded-2xl border border-[#E8E6E1] bg-white p-4 shadow-card'

  if (stat.to) {
    return (
      <Link to={stat.to} aria-label={stat.toLabel} className={cn(className, 'block text-left transition-transform active:scale-[0.98]')}>
        {body}
      </Link>
    )
  }
  return <div className={className}>{body}</div>
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { t, locale } = useTranslation()
  const [store, setStore] = useState('all')
  const [stores, setStores] = useState([])
  const [orders, setOrders] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  // Aggregated server-side; see src/lib/salesReport.js. Null until loaded, and
  // left null on failure so the Orders Today / Revenue tiles degrade to 0
  // rather than showing a figure derived some other way — two different
  // methods producing two different numbers is exactly what this prevents.
  const [actionableReport, setActionableReport] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    // RLS scopes every table to the logged-in user's own stores/orders/products.

    // This deliberately does NOT load the whole orders table. It used to, which
    // silently truncated at PostgREST's 1000-row cap once the account passed
    // 1244 orders — and raising that number would just move the fuse.
    //
    // Instead each thing the dashboard actually derives is fetched as its own
    // BOUNDED query, so cost is O(today + pending + 5·stores) and never grows
    // with lifetime order count:
    //   - today's orders  -> the stat tiles and per-platform breakdown
    //   - READY_TO_SHIP   -> the "to pack" tile (previously counted across the
    //                        truncated page, so an old unshipped order past row
    //                        1000 would have gone uncounted)
    //   - 5 newest/store  -> the recent-orders list. Per-store rather than a
    //                        global limit because the store filter is applied
    //                        client-side; the global newest 5 is always a
    //                        subset of the union of each store's newest 5.
    const storesRes = await supabase
      .from('stores')
      .select('id, platform, shop_name, shop_id')
      .order('created_at', { ascending: false })
    const storeRows = storesRes.data ?? []

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [todayRes, toPackRes, recentResults, productsRes] = await Promise.all([
      selectAllPaged('dashboard.orders.today', (from, to) =>
        supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .gte('order_created_at', todayStart.toISOString())
          .range(from, to)
      ),
      selectAllPaged('dashboard.orders.toPack', (from, to) =>
        supabase.from('orders').select(ORDER_COLUMNS).eq('order_status', 'READY_TO_SHIP').range(from, to)
      ),
      Promise.all(
        storeRows.map((s) =>
          supabase
            .from('orders')
            .select(ORDER_COLUMNS)
            .eq('store_id', s.id)
            .order('order_created_at', { ascending: false })
            .limit(RECENT_ORDERS_PER_STORE)
        )
      ),
      selectAllPaged('dashboard.products', (from, to) =>
        supabase.from('products').select('store_id, stock').range(from, to)
      ),
    ])

    // The three order sets overlap (a READY_TO_SHIP order placed today appears
    // in all of them), so merge on id before anything counts them.
    const byId = new Map()
    for (const row of todayRes.data ?? []) byId.set(row.id, row)
    for (const row of toPackRes.data ?? []) byId.set(row.id, row)
    for (const res of recentResults) for (const row of res.data ?? []) byId.set(row.id, row)

    const merged = [...byId.values()].sort(
      (a, b) => new Date(b.order_created_at) - new Date(a.order_created_at)
    )

    setStores(storeRows)
    setOrders(merged)
    setProducts(productsRes.data ?? [])

    // Separate from the Promise.all above on purpose: if the reporting
    // function isn't installed yet, the rest of the dashboard must still
    // render rather than the whole page failing on a missing RPC.
    try {
      setActionableReport(await fetchActionableOrdersReport())
    } catch (err) {
      console.error('[dashboard] actionable orders report unavailable', err)
      setActionableReport(null)
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData()
  }, [fetchData])

  const storeOptions = useMemo(() => {
    return [
      { value: 'all', label: t('dashboard.allStores') },
      ...stores.map((s) => ({
        value: s.id,
        label: `${platformLabel(s.platform)} - ${s.shop_name || s.shop_id}`,
      })),
    ]
  }, [stores, t])

  // Orders/products scoped to the selected store (or all).
  const scopedOrders = useMemo(
    () => (store === 'all' ? orders : orders.filter((o) => o.store_id === store)),
    [orders, store]
  )
  const scopedProducts = useMemo(
    () => (store === 'all' ? products : products.filter((p) => p.store_id === store)),
    [products, store]
  )

  const stats = useMemo(() => {
    const toPack = scopedOrders.filter((o) => o.order_status === 'READY_TO_SHIP').length
    const lowStock = scopedProducts.filter((p) => (Number(p.stock) || 0) <= 10).length

    // Orders Today + Revenue come from todays_actionable_orders() RPC, NOT
    // from scopedOrders — see supabase/actionable_orders_migration.sql. An
    // order counts when it's today's (Malaysia time) UNLESS it's cancelled,
    // or unpaid with a non-COD payment method. Both tiles read the same query
    // so they can never disagree, and Yesterday reads the same definition as
    // Today, so the tile's own two lines can't contradict each other either.
    const series = seriesFor(actionableReport, store)
    const today = figuresForDay(series, todayKL())
    const yesterday = figuresForDay(series, addDaysISO(todayKL(), -1))

    return [
      {
        id: 'ordersToday',
        label: t('dashboard.stats.ordersToday'),
        value: actionableReport ? String(today.orderCount) : '0',
        valueClass: 'text-[#1F2937]',
      },
      {
        id: 'revenue',
        label: t('dashboard.stats.revenue'),
        value: actionableReport ? formatRM(today.revenue) : formatRM(0),
        valueClass: 'text-[#1F2937]',
        // Bottom nav is full, so the revenue tile is the way into the report.
        to: '/sales',
        toLabel: t('sales.open'),
        // Rendered as a smaller line under the value; same series, same day
        // bucketing, so it can never disagree with the number above it.
        sub: actionableReport ? `${t('sales.yesterday')}: ${formatRM(yesterday.revenue)}` : null,
      },
      { id: 'toPack', label: t('status.toPack'), value: String(toPack), valueClass: 'text-red-600' },
      { id: 'lowStock', label: t('dashboard.stats.lowStock'), value: String(lowStock), valueClass: 'text-yellow-700' },
    ]
  }, [scopedOrders, scopedProducts, actionableReport, store, t])

  const platforms = useMemo(() => {
    const connectedSet = new Set(stores.map((s) => platformLabel(s.platform)))
    const todaysOrders = scopedOrders.filter((o) => isToday(o.order_created_at))

    return PLATFORM_ORDER.map((name) => {
      const display = PLATFORM_DISPLAY[name]
      const forPlatform = todaysOrders.filter((o) => platformLabel(o.platform) === name)
      const count = forPlatform.length
      // Same rule daily_sales() applies to the revenue tile above — see
      // countsAsRevenue in src/lib/salesReport.js. This sum used to include
      // EVERY status, so a card could claim revenue for a cancelled or unpaid
      // order that the tile (correctly) left out, and the two would disagree
      // for reasons no one could see. The counts beside them stay unfiltered
      // on purpose: "orders today" is a different question from "revenue
      // today", and the tile pair at the top of the page splits it the same
      // way.
      //
      // Summing client-side is safe HERE and only here: today's orders are
      // fetched in full via selectAllPaged, so there is no 1,000-row cap to
      // silently truncate the way an all-time sum would.
      const revenue = forPlatform.reduce(
        (sum, o) => sum + (countsAsRevenue(o) ? Number(o.total_amount) || 0 : 0),
        0
      )
      return {
        name,
        dotClass: display.dotClass,
        // t() picks _one/_other off `count` itself — see pluralKey in
        // I18nProvider. The ternary this replaces did the same thing by hand.
        orders: t('dashboard.platforms.orderCount', { count }),
        revenue: formatRevenue(revenue),
        connected: connectedSet.has(name),
      }
    })
  }, [stores, scopedOrders, t])

  const recentOrders = useMemo(() => {
    return scopedOrders.slice(0, 5).map((row) => {
      const name = platformLabel(row.platform)
      const display = PLATFORM_DISPLAY[name] ?? PLATFORM_DISPLAY.Shopee
      const statusKey = statusKeyFor(row.platform, row.order_status)
      // Unmapped raw statuses fall back to Shopee's own raw string verbatim
      // (that's data passthrough, same treatment as an unrecognized status
      // anywhere else in the app) rather than forcing it through a
      // translation key that may not exist for it.
      const status = statusKey ? t(`status.${statusKey}`) : row.order_status || ''
      const statusClass = statusKey ? (STATUS_CLASS[statusKey] ?? DEFAULT_STATUS_CLASS) : DEFAULT_STATUS_CLASS
      return {
        id: `#${row.platform_order_id}`,
        letter: display.letter,
        badgeClass: display.badgeClass,
        buyer: row.buyer_name || t('dashboard.recentOrders.unknownBuyer'),
        amount: `RM ${(Number(row.total_amount) || 0).toFixed(2)}`,
        status,
        statusClass,
        timeAgo: formatRelativeToNow(locale, row.order_created_at),
      }
    })
  }, [scopedOrders, t, locale])

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-[#6B7280]">{t('dashboard.greeting')}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-[#6B7280] hover:text-[#1F2937]"
          >
            <Bell className="h-5 w-5" />
          </Button>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1F2937]">MyStore Hub</h1>
        <p className="text-sm text-[#6B7280]">{formatToday(locale)}</p>

        <Select items={storeOptions} value={store} onValueChange={setStore}>
          <SelectTrigger className="mt-3 h-11 w-full rounded-xl !bg-white border-[#E8E6E1] text-[#1F2937]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-white border border-[#E8E6E1] text-[#1F2937]">
            {storeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <section className="px-4 pt-3">
        <button
          type="button"
          onClick={() => navigate('/scan')}
          className="flex w-full items-center gap-3 rounded-2xl border border-[#E8E6E1] bg-white p-4 text-left shadow-card transition-transform active:scale-[0.98]"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2563EB]/15">
            <ScanLine className="h-5 w-5 text-[#2563EB]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[#1F2937]">{t('dashboard.scanCard.title')}</span>
            <span className="mt-0.5 block text-xs text-[#6B7280]">
              {t('dashboard.scanCard.description')}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-[#2563EB]" />
        </button>
      </section>

      <section className="flex flex-nowrap gap-3 overflow-x-auto px-4 py-3">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="min-w-[140px] shrink-0 rounded-2xl border border-[#E8E6E1] bg-white p-4 shadow-card">
                <Skeleton className="h-7 w-16 bg-gray-200" />
                <Skeleton className="mt-2.5 h-4 w-20 bg-gray-200" />
              </div>
            ))
          : stats.map((stat) => (
              <StatTile key={stat.id} stat={stat} />
            ))}
      </section>

      {/* Stated in the UI rather than buried in a tooltip — same reasoning as
          sales.basis on the Sales page: which orders count is the one
          assumption these two figures rest on, and Revenue here includes
          money not yet received. */}
      <p className="px-4 pb-1 text-[11px] leading-relaxed text-gray-500">
        {t('dashboard.stats.basis')}
      </p>

      <section className="px-4">
        <h2 className="mb-2.5 font-semibold text-[#1F2937]">{t('dashboard.platforms.title')}</h2>
        <div className="grid grid-cols-2 gap-3">
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-[#E8E6E1] bg-white p-3.5 shadow-card">
                  <Skeleton className="h-4 w-20 bg-gray-200" />
                  <Skeleton className="mt-3 h-3 w-16 bg-gray-200" />
                  <Skeleton className="mt-2 h-4 w-14 bg-gray-200" />
                </div>
              ))
            : platforms.map((platform) => (
                <div key={platform.name} className="rounded-2xl border border-[#E8E6E1] bg-white p-3.5 shadow-card">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', platform.dotClass)} />
                    <span className="truncate text-sm font-medium text-[#1F2937]">{platform.name}</span>
                  </div>
                  {platform.connected ? (
                    <>
                      <p className="mt-2.5 text-xs text-[#6B7280]">{platform.orders}</p>
                      <p className="text-sm font-semibold tabular-nums text-[#1F2937]">{platform.revenue}</p>
                      <p className="mt-2 text-xs font-medium text-green-600">
                        ● {t('dashboard.platforms.connected')}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2.5 text-xs text-gray-500">{t('dashboard.platforms.notConnected')}</p>
                  )}
                </div>
              ))}
        </div>
      </section>

      <section className="mt-5 px-4">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="font-semibold text-[#1F2937]">{t('dashboard.recentOrders.title')}</h2>
          <Link to="/orders" className="text-sm font-medium text-[#2563EB]">
            {t('dashboard.recentOrders.viewAll')}
          </Link>
        </div>
        <div className="rounded-2xl border border-[#E8E6E1] bg-white shadow-card">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-3 px-3.5 py-3',
                  i < 4 && 'border-b border-[#E8E6E1]'
                )}
              >
                <Skeleton className="h-9 w-9 shrink-0 rounded-full bg-gray-200" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3 w-20 bg-gray-200" />
                  <Skeleton className="mt-1.5 h-4 w-28 bg-gray-200" />
                </div>
                <Skeleton className="h-4 w-16 bg-gray-200" />
              </div>
            ))
          ) : recentOrders.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">{t('dashboard.recentOrders.empty')}</p>
          ) : (
            recentOrders.map((order, i) => (
              <div
                key={order.id}
                className={cn(
                  'flex items-center gap-3 px-3.5 py-3',
                  i < recentOrders.length - 1 && 'border-b border-[#E8E6E1]'
                )}
              >
                <div
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
                    order.badgeClass
                  )}
                >
                  {order.letter}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#1F2937]">{order.buyer}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-[#6B7280]">
                    {order.id}
                    {order.timeAgo ? ` · ${order.timeAgo}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-sm font-semibold tabular-nums text-[#1F2937]">{order.amount}</span>
                  <span className={cn(BADGE_CLS, order.statusClass)}>{order.status}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mt-5 px-4">
        <h2 className="mb-2.5 font-semibold text-[#1F2937]">{t('dashboard.quickActions.title')}</h2>
        {/* Four actions no longer fit side-by-side at flex-1 on a phone, so this
            is a grid — same card styling, just wrapped into even columns. */}
        <div className="grid grid-cols-4 gap-2">
          <button className="rounded-2xl border border-[#E8E6E1] bg-white p-3 text-center shadow-card transition-transform active:scale-[0.98]">
            <Printer className="mx-auto mb-1.5 h-5 w-5 text-[#6B7280]" />
            <span className="text-[11px] font-medium text-[#6B7280]">{t('dashboard.quickActions.printAwb')}</span>
          </button>
          <button
            onClick={() => navigate('/orders')}
            className="rounded-2xl border border-[#E8E6E1] bg-white p-3 text-center shadow-card transition-transform active:scale-[0.98]"
          >
            <ShoppingBag className="mx-auto mb-1.5 h-5 w-5 text-[#6B7280]" />
            <span className="text-[11px] font-medium text-[#6B7280]">{t('dashboard.quickActions.newOrders')}</span>
          </button>
          <button
            onClick={() => navigate('/boost')}
            className="rounded-2xl border border-[#E8E6E1] bg-white p-3 text-center shadow-card transition-transform active:scale-[0.98]"
          >
            <Zap className="mx-auto mb-1.5 h-5 w-5 text-[#6B7280]" />
            <span className="text-[11px] font-medium text-[#6B7280]">{t('dashboard.quickActions.boostNow')}</span>
          </button>
          <button
            onClick={() => navigate('/flash-deals')}
            className="rounded-2xl border border-[#E8E6E1] bg-white p-3 text-center shadow-card transition-transform active:scale-[0.98]"
          >
            <Flame className="mx-auto mb-1.5 h-5 w-5 text-[#6B7280]" />
            <span className="text-[11px] font-medium text-[#6B7280]">{t('dashboard.quickActions.flashDeals')}</span>
          </button>
        </div>
      </section>
    </div>
  )
}
