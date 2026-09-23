import { useCallback, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import PullToRefresh from '@/components/PullToRefresh'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { useDateTime } from '@/lib/i18n/datetime'
import { statusKeyFor } from '@/lib/orderStatus'
import {
  BADGE_CLS,
  DEFAULT_STATUS_CLASS,
  PLATFORM_DISPLAY,
  STATUS_CLASS,
  platformLabel,
} from '@/lib/orderDisplay'
import {
  REVENUE_BREAKDOWN_DAYS,
  addDaysISO,
  fetchRevenueBreakdown,
  formatRM,
  todayKL,
} from '@/lib/salesReport'

// The auditable list behind the Dashboard Revenue tile. Every row is an order
// actionable_orders_for_day() returned — the same rows the tile's aggregate
// sums (supabase/actionable_orders_migration.sql) — so nothing here decides
// which orders count. The page only adds them up and displays them.

const BREAKDOWN_QUERY_KEY = ['revenue-breakdown']
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// URL-driven so a day/store is linkable and survives a reload; anything
// outside the 30-day window (or malformed) falls back to today rather than
// querying a day the RPC would just return empty for.
function resolveDay(param, today) {
  const oldest = addDaysISO(today, -(REVENUE_BREAKDOWN_DAYS - 1))
  return param && DAY_RE.test(param) && param >= oldest && param <= today ? param : today
}

function OrderRow({ order, t, formatDateTime }) {
  const name = platformLabel(order.platform)
  const display = PLATFORM_DISPLAY[name]
  const statusKey = statusKeyFor(order.platform, order.status)
  const statusLabel = statusKey ? t(`status.${statusKey}`) : order.status || ''
  const statusClass = statusKey ? (STATUS_CLASS[statusKey] ?? DEFAULT_STATUS_CLASS) : DEFAULT_STATUS_CLASS

  return (
    <div className="border-b border-[#E8E6E1] px-3.5 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white',
              display?.badgeClass ?? 'bg-gray-500'
            )}
          >
            {name}
          </span>
          <span className="truncate text-sm font-medium text-[#1F2937]">{order.shopName}</span>
        </div>
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-[#1F2937]">
          {formatRM(order.amount)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs tabular-nums text-[#6B7280]">
          #{order.platformOrderId}
        </span>
        <span className={cn(BADGE_CLS, 'shrink-0 whitespace-nowrap', statusClass)}>{statusLabel}</span>
      </div>

      <p className="mt-1.5 text-xs text-[#6B7280]">
        {t('revenueBreakdown.placed', { date: formatDateTime(order.createdAt) })}
      </p>
    </div>
  )
}

export default function RevenueBreakdown() {
  const { t } = useTranslation()
  const { formatDateTime, formatDayLong } = useDateTime()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const today = todayKL()
  const oldest = addDaysISO(today, -(REVENUE_BREAKDOWN_DAYS - 1))
  const day = resolveDay(searchParams.get('day'), today)
  const store = searchParams.get('store') || 'all'

  const setParam = useCallback(
    (key, value, fallback) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value === fallback) next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const { data: stores = [] } = useQuery({
    queryKey: ['revenue-breakdown-stores'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('stores')
        .select('id, platform, shop_name, shop_id')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
  })

  const { data, isPending, error } = useQuery({
    queryKey: [...BREAKDOWN_QUERY_KEY, day, store],
    queryFn: () => fetchRevenueBreakdown({ day, storeId: store }),
  })

  // Pull-to-refresh: revalidate the list, not a marketplace sync — same
  // reasoning as Orders' pull (Supabase is already kept fresh by the cron).
  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey: BREAKDOWN_QUERY_KEY }),
    [queryClient]
  )

  const storeOptions = useMemo(
    () => [
      { value: 'all', label: t('revenueBreakdown.allStores') },
      ...stores.map((s) => ({
        value: s.id,
        label: `${platformLabel(s.platform)} - ${s.shop_name || s.shop_id}`,
      })),
    ],
    [stores, t]
  )

  const dayOptions = useMemo(
    () =>
      Array.from({ length: REVENUE_BREAKDOWN_DAYS }, (_, i) => {
        const iso = addDaysISO(today, -i)
        const label = formatDayLong(iso)
        return { value: iso, label: i === 0 ? `${t('revenueBreakdown.today')} · ${label}` : label }
      }),
    [today, formatDayLong, t]
  )

  // Summed in integer cents so the total is exact, then compared with the
  // tile's own figure for this day — the proof the list is complete.
  const summary = useMemo(() => {
    if (!data) return null
    const cents = data.orders.reduce((sum, o) => sum + Math.round(o.amount * 100), 0)
    const total = cents / 100
    const matches =
      cents === Math.round(data.figures.revenue * 100) && data.orders.length === data.figures.orderCount
    return { total, count: data.orders.length, matches }
  }, [data])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Link
            to="/sales"
            aria-label={t('sales.title')}
            className="-ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-[#F3F4F6]"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-[#1F2937]">{t('revenueBreakdown.title')}</h1>
            <p className="text-sm text-[#6B7280]">{t('revenueBreakdown.subtitle')}</p>
          </div>
        </div>
      </header>

      <PullToRefresh onRefresh={refetch} className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="space-y-2 px-4 pt-1">
          {/* `items` makes SelectValue render the LABEL, same contract as the
              Dashboard's store picker. */}
          <Select items={storeOptions} value={store} onValueChange={(v) => setParam('store', v, 'all')}>
            <SelectTrigger className="h-11 w-full rounded-xl border-[#E8E6E1] !bg-white text-[#1F2937] shadow-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-[#E8E6E1] bg-white text-[#1F2937]">
              {storeOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Day picker: step buttons plus a list of exactly the 30 selectable
              days, so an out-of-range day can't be entered. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t('revenueBreakdown.prevDay')}
              disabled={day <= oldest}
              onClick={() => setParam('day', addDaysISO(day, -1), today)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E8E6E1] bg-white text-[#1F2937] shadow-card disabled:opacity-40"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <Select items={dayOptions} value={day} onValueChange={(v) => setParam('day', v, today)}>
              <SelectTrigger
                aria-label={t('revenueBreakdown.dayPicker')}
                className="h-11 min-w-0 flex-1 rounded-xl border-[#E8E6E1] !bg-white text-[#1F2937] shadow-card"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-[#E8E6E1] bg-white text-[#1F2937]">
                {dayOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              aria-label={t('revenueBreakdown.nextDay')}
              disabled={day >= today}
              onClick={() => setParam('day', addDaysISO(day, 1), today)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E8E6E1] bg-white text-[#1F2937] shadow-card disabled:opacity-40"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        {error ? (
          <div className="mx-4 mt-3 rounded-2xl border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{t('revenueBreakdown.error')}</p>
            <p className="mt-1 font-mono text-xs text-red-500">{error.message}</p>
          </div>
        ) : isPending ? (
          <div className="mt-3 space-y-3 px-4">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-56 w-full rounded-2xl" />
          </div>
        ) : (
          <>
            <section className="mx-4 mt-3 rounded-2xl border border-[#E8E6E1] bg-white p-3 shadow-card">
              <p className="text-sm text-[#6B7280]">{t('revenueBreakdown.total')}</p>
              <p className="mt-0.5 whitespace-nowrap text-3xl font-bold tabular-nums text-[#1F2937]">
                {formatRM(summary.total)}
              </p>
              <p className="mt-0.5 text-sm tabular-nums text-[#6B7280]">
                {t('revenueBreakdown.orderCount', { count: summary.count })}
              </p>
              {summary.matches ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-green-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  {t('revenueBreakdown.matches')}
                </p>
              ) : (
                <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-amber-700">
                  <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
                  {t('revenueBreakdown.mismatch', {
                    expected: formatRM(data.figures.revenue),
                    orders: t('revenueBreakdown.orderCount', { count: data.figures.orderCount }),
                  })}
                </p>
              )}
            </section>

            <section className="mx-4 mt-3 overflow-hidden rounded-2xl border border-[#E8E6E1] bg-white shadow-card">
              {data.orders.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">{t('revenueBreakdown.empty')}</p>
              ) : (
                data.orders.map((order) => (
                  <OrderRow key={order.id} order={order} t={t} formatDateTime={formatDateTime} />
                ))
              )}
            </section>

            <p className="mx-4 mt-3 text-xs leading-relaxed text-gray-500">{t('dashboard.stats.basis')}</p>
          </>
        )}
      </PullToRefresh>
    </div>
  )
}
