import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
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
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'

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

// Maps Shopee's raw order_status to a STABLE status key — never the
// translated display label — so STATUS_CLASS and the translation dictionary
// can both key off something that doesn't change when the locale does.
// Rendering the label itself always goes through t('dashboard.status.<key>')
// instead of using this map's values directly (that was the previous bug:
// SHOPEE_STATUS_MAP used to hold the English display string, and STATUS_CLASS
// was keyed by that same string — switching locale would have translated the
// on-screen text while STATUS_CLASS's keys stayed English, so every badge
// would have silently fallen back to the default gray class).
const SHOPEE_STATUS_KEY = {
  UNPAID: 'new',
  READY_TO_SHIP: 'toPack',
  PROCESSED: 'packed',
  SHIPPED: 'shipped',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
}

const STATUS_CLASS = {
  new: 'bg-blue-500/15 text-blue-600',
  toPack: 'bg-yellow-600/15 text-yellow-700',
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

export default function Dashboard() {
  const navigate = useNavigate()
  const { t, locale } = useTranslation()
  const [store, setStore] = useState('all')
  const [stores, setStores] = useState([])
  const [orders, setOrders] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    // RLS scopes every table to the logged-in user's own stores/orders/products.
    const [storesRes, ordersRes, productsRes] = await Promise.all([
      supabase
        .from('stores')
        .select('id, platform, shop_name, shop_id')
        .order('created_at', { ascending: false }),
      supabase
        .from('orders')
        .select(
          'id, store_id, platform, order_status, buyer_name, total_amount, order_created_at, platform_order_id'
        )
        .order('order_created_at', { ascending: false }),
      supabase.from('products').select('store_id, stock'),
    ])

    setStores(storesRes.data ?? [])
    setOrders(ordersRes.data ?? [])
    setProducts(productsRes.data ?? [])
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
    const todaysOrders = scopedOrders.filter((o) => isToday(o.order_created_at))
    const revenueToday = todaysOrders.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0)
    const toPack = scopedOrders.filter((o) => o.order_status === 'READY_TO_SHIP').length
    const lowStock = scopedProducts.filter((p) => (Number(p.stock) || 0) <= 10).length

    return [
      { id: 'ordersToday', label: t('dashboard.stats.ordersToday'), value: String(todaysOrders.length), valueClass: 'text-[#1F2937]' },
      { id: 'revenue', label: t('dashboard.stats.revenue'), value: formatRevenue(revenueToday), valueClass: 'text-[#1F2937]' },
      { id: 'toPack', label: t('dashboard.status.toPack'), value: String(toPack), valueClass: 'text-red-600' },
      { id: 'lowStock', label: t('dashboard.stats.lowStock'), value: String(lowStock), valueClass: 'text-yellow-700' },
    ]
  }, [scopedOrders, scopedProducts, t])

  const platforms = useMemo(() => {
    const connectedSet = new Set(stores.map((s) => platformLabel(s.platform)))
    const todaysOrders = scopedOrders.filter((o) => isToday(o.order_created_at))

    return PLATFORM_ORDER.map((name) => {
      const display = PLATFORM_DISPLAY[name]
      const forPlatform = todaysOrders.filter((o) => platformLabel(o.platform) === name)
      const count = forPlatform.length
      const revenue = forPlatform.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0)
      return {
        name,
        dotClass: display.dotClass,
        orders: t(count === 1 ? 'dashboard.platforms.orderCount_one' : 'dashboard.platforms.orderCount_other', { count }),
        revenue: formatRevenue(revenue),
        connected: connectedSet.has(name),
      }
    })
  }, [stores, scopedOrders, t])

  const recentOrders = useMemo(() => {
    return scopedOrders.slice(0, 5).map((row) => {
      const name = platformLabel(row.platform)
      const display = PLATFORM_DISPLAY[name] ?? PLATFORM_DISPLAY.Shopee
      const statusKey = SHOPEE_STATUS_KEY[row.order_status] ?? null
      // Unmapped raw statuses fall back to Shopee's own raw string verbatim
      // (that's data passthrough, same treatment as an unrecognized status
      // anywhere else in the app) rather than forcing it through a
      // translation key that may not exist for it.
      const status = statusKey ? t(`dashboard.status.${statusKey}`) : row.order_status || t('dashboard.status.new')
      const statusClass = statusKey ? (STATUS_CLASS[statusKey] ?? DEFAULT_STATUS_CLASS) : DEFAULT_STATUS_CLASS
      return {
        id: `#${row.platform_order_id}`,
        letter: display.letter,
        badgeClass: display.badgeClass,
        buyer: row.buyer_name || t('dashboard.recentOrders.unknownBuyer'),
        amount: `RM ${(Number(row.total_amount) || 0).toFixed(2)}`,
        status,
        statusClass,
        timeAgo: row.order_created_at
          ? formatDistanceToNow(new Date(row.order_created_at), {
              addSuffix: true,
              locale: locale === 'zh-CN' ? zhCN : undefined,
            })
          : '',
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
              <div key={stat.id} className="min-w-[140px] shrink-0 rounded-2xl border border-[#E8E6E1] bg-white p-4 shadow-card">
                <p className={cn('text-2xl font-bold tabular-nums', stat.valueClass)}>{stat.value}</p>
                <p className="mt-0.5 text-sm text-[#6B7280]">{stat.label}</p>
              </div>
            ))}
      </section>

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
