import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Info } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { supabase } from '@/lib/supabase'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { cn } from '@/lib/utils'
import {
  coverageFor,
  fetchSalesReport,
  formatRM,
  seriesFor,
} from '@/lib/salesReport'

// Sales report. Every figure here comes from the daily_sales() RPC via
// src/lib/salesReport.js — the same path the Dashboard's revenue tile uses, so
// the two can never disagree. Nothing on this page sums orders client-side.

/**
 * ONE series, not four.
 *
 * The store dimension is a filter, not a set of stacked series. Four stacked
 * segments across 30 days at 390px would be ~3px of colour each — unreadable,
 * and it would need a categorical palette to carry identity that the filter
 * already carries unambiguously. One series also means no legend is needed:
 * the card title says what is plotted.
 *
 * Hand-rolled rather than recharts (which is in package.json but unused
 * anywhere): 30 bars need flexbox and two divs, and pulling a charting runtime
 * into the bundle for that would cost far more than it returns. It also lets
 * the 2px surface gap and the 4px rounded data-end be exact rather than
 * approximated through a library's props.
 */
function RevenueChart({ series, coverageFirstDay, t, locale }) {
  const [activeIdx, setActiveIdx] = useState(null)

  const max = useMemo(() => Math.max(0, ...series.map((d) => d.revenue)), [series])

  // Clean axis ceiling so the ticks read as round numbers rather than
  // whatever the tallest bar happens to be.
  const ceiling = useMemo(() => {
    if (max <= 0) return 0
    const magnitude = 10 ** Math.floor(Math.log10(max))
    return Math.ceil(max / magnitude) * magnitude
  }, [max])

  const ticks = useMemo(() => {
    if (ceiling <= 0) return [0]
    return [ceiling, ceiling / 2, 0]
  }, [ceiling])

  const dayLabel = useCallback(
    (iso) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-MY', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    [locale]
  )

  if (series.length === 0 || max <= 0) {
    return (
      <p className="py-10 text-center text-xs text-gray-400">{t('sales.chart.noSales')}</p>
    )
  }

  const active = activeIdx != null ? series[activeIdx] : null

  return (
    <div>
      {/* Tooltip sits above the plot rather than floating over it, so it can
          never cover the bar being read — and it has a fixed height so hovering
          doesn't shift the chart. */}
      <div className="mb-1 h-8">
        {active ? (
          <div className="inline-flex items-baseline gap-2 rounded-lg bg-[#1F2937] px-2.5 py-1.5">
            <span className="text-[11px] text-white/70">{dayLabel(active.day)}</span>
            <span className="text-xs font-semibold tabular-nums text-white">
              {formatRM(active.revenue)}
            </span>
            <span className="text-[11px] tabular-nums text-white/70">
              {active.orderCount} {t('sales.table.orders').toLowerCase()}
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-gray-400">
            {t('sales.table.date')} · {t('sales.table.revenue')}
          </span>
        )}
      </div>

      <div className="relative h-40 pl-11">
        {/* Hairline solid gridlines, one step off the surface — recessive. */}
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute left-11 right-0 flex items-center"
            style={{ bottom: `${ceiling > 0 ? (tick / ceiling) * 100 : 0}%` }}
          >
            <span className="absolute -left-11 w-10 text-right text-[10px] tabular-nums text-gray-400">
              {Math.round(tick).toLocaleString('en-MY')}
            </span>
            <div className="h-px w-full bg-[#E8E6E1]" />
          </div>
        ))}

        {/* gap-[2px] is the surface gap that separates touching bars. */}
        <div className="relative flex h-full items-end gap-[2px]">
          {series.map((d, i) => {
            const beforeHistory = coverageFirstDay != null && d.day < coverageFirstDay
            const pct = ceiling > 0 ? (d.revenue / ceiling) * 100 : 0
            return (
              <button
                key={d.day}
                type="button"
                // The band is the hit target, full height — far bigger than a
                // ~8px-wide bar, and it still works for a zero-revenue day.
                className="group relative flex h-full flex-1 items-end"
                onMouseEnter={() => setActiveIdx(i)}
                onMouseLeave={() => setActiveIdx((prev) => (prev === i ? null : prev))}
                onFocus={() => setActiveIdx(i)}
                onBlur={() => setActiveIdx((prev) => (prev === i ? null : prev))}
                onClick={() => setActiveIdx((prev) => (prev === i ? null : i))}
                aria-label={`${dayLabel(d.day)}: ${formatRM(d.revenue)}, ${d.orderCount}`}
              >
                {beforeHistory ? (
                  // Outside synced history — deliberately NOT drawn as a zero
                  // bar, because "no data" and "no sales" are different claims.
                  <span className="mx-auto w-full max-w-[24px] rounded-t border-t border-dashed border-[#E8E6E1] bg-[#F3F4F6] opacity-70" style={{ height: '100%' }} />
                ) : (
                  <span
                    className={cn(
                      // max-w caps the bar at 24px so wide screens get air
                      // rather than fat blocks; mx-auto keeps it centred in
                      // its band.
                      'mx-auto w-full max-w-[24px] rounded-t bg-[#2563EB] transition-opacity',
                      activeIdx != null && activeIdx !== i && 'opacity-40'
                    )}
                    style={{ height: `${pct}%` }}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Only the endpoints are labelled — a tick under all 30 bars would be an
          unreadable smear at 390px, and every exact value is in the table. */}
      <div className="mt-1.5 flex justify-between pl-11 text-[10px] text-gray-400">
        <span>{dayLabel(series[0].day)}</span>
        <span>{dayLabel(series[series.length - 1].day)}</span>
      </div>
    </div>
  )
}

export default function Sales() {
  const { t, locale } = useTranslation()
  const [stores, setStores] = useState([])
  const [store, setStore] = useState('all')
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      setLoading(true)
      try {
        // Bounded by nature (one row per connected store), so no paging needed.
        const [{ data: storeRows }, reportData] = await Promise.all([
          supabase.from('stores').select('id, shop_name, shop_id, platform').order('shop_name'),
          fetchSalesReport(),
        ])
        if (cancelled) return
        setStores(storeRows ?? [])
        setReport(reportData)
        setError(null)
      } catch (err) {
        if (cancelled) return
        console.error('[sales] load failed', err)
        setError(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const series = useMemo(() => seriesFor(report, store), [report, store])
  const coverage = useMemo(() => coverageFor(report, store), [report, store])

  // Days in the window that predate the synced history. Shown as a caveat
  // instead of being silently drawn as zero revenue.
  const missingLeadingDays = useMemo(() => {
    if (!coverage?.firstDay || series.length === 0) return 0
    return series.filter((d) => d.day < coverage.firstDay).length
  }, [coverage, series])

  const totals = useMemo(() => {
    const covered = series.filter((d) => !coverage?.firstDay || d.day >= coverage.firstDay)
    const revenue = covered.reduce((sum, d) => sum + d.revenue, 0)
    const orders = covered.reduce((sum, d) => sum + d.orderCount, 0)
    return {
      revenue,
      orders,
      // Averaged over days we actually have history for — dividing by a flat
      // 30 would understate the average whenever the window runs past the
      // start of the data.
      avgPerDay: covered.length > 0 ? revenue / covered.length : 0,
      coveredDays: covered.length,
    }
  }, [series, coverage])

  const storeOptions = useMemo(
    () => [
      { value: 'all', label: t('sales.allStores') },
      ...stores.map((s) => ({ value: s.id, label: s.shop_name || String(s.shop_id) })),
    ],
    [stores, t]
  )

  const rows = useMemo(() => [...series].reverse(), [series])

  const dayLabelLong = useCallback(
    (iso) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-MY', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    [locale]
  )

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Link
            to="/dashboard"
            aria-label={t('nav.dashboard')}
            className="-ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-[#F3F4F6]"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-[#1F2937]">{t('sales.title')}</h1>
            <p className="text-sm text-[#6B7280]">{t('sales.subtitle')}</p>
          </div>
        </div>
      </header>

      <div className="px-4 pt-2">
        {/* `items` is required for SelectValue to render the LABEL rather than
            the raw value — same contract the Dashboard's store picker uses. */}
        <Select items={storeOptions} value={store} onValueChange={setStore}>
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
      </div>

      {error ? (
        <div className="mx-4 mt-3 rounded-2xl border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">{t('sales.error')}</p>
          <p className="mt-1 font-mono text-[10px] text-red-500">{error.message}</p>
        </div>
      ) : loading ? (
        <div className="mt-3 space-y-3 px-4">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-56 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          {/* ---- history coverage caveat ---- */}
          {coverage == null || coverage.orderCount === 0 ? (
            <div className="mx-4 mt-3 flex gap-2 rounded-2xl border border-yellow-300 bg-yellow-50 p-3">
              <Info className="h-4 w-4 shrink-0 text-yellow-600" />
              <p className="text-xs text-yellow-900">{t('sales.coverage.none')}</p>
            </div>
          ) : missingLeadingDays > 0 ? (
            <div className="mx-4 mt-3 flex gap-2 rounded-2xl border border-yellow-300 bg-yellow-50 p-3">
              <Info className="h-4 w-4 shrink-0 text-yellow-600" />
              <p className="text-xs text-yellow-900">
                {t('sales.coverage.partial', {
                  date: dayLabelLong(coverage.firstDay),
                  days: missingLeadingDays,
                })}
              </p>
            </div>
          ) : null}

          {/* ---- totals ---- */}
          {/* Revenue is the hero number and gets its own full-width row: three
              equal columns at 390px wrap "RM 23,654.98" onto two lines. The
              other two are short enough to share a row. */}
          <section className="mt-3 grid grid-cols-2 gap-2 px-4 md:grid-cols-4">
            <div className="col-span-2 rounded-2xl border border-[#E8E6E1] bg-white p-3 shadow-card md:col-span-2">
              <p className="text-[11px] text-[#6B7280]">{t('sales.totals.revenue')}</p>
              <p className="mt-0.5 text-2xl font-bold tabular-nums text-[#1F2937]">
                {formatRM(totals.revenue)}
              </p>
            </div>
            <div className="rounded-2xl border border-[#E8E6E1] bg-white p-3 shadow-card">
              <p className="truncate text-[11px] text-[#6B7280]">{t('sales.totals.orders')}</p>
              <p className="mt-0.5 text-base font-bold tabular-nums text-[#1F2937]">
                {totals.orders.toLocaleString('en-MY')}
              </p>
            </div>
            <div className="rounded-2xl border border-[#E8E6E1] bg-white p-3 shadow-card">
              <p className="truncate text-[11px] text-[#6B7280]">{t('sales.totals.avgPerDay')}</p>
              <p className="mt-0.5 text-base font-bold tabular-nums text-[#1F2937]">
                {formatRM(totals.avgPerDay)}
              </p>
            </div>
          </section>

          {/* ---- chart ---- */}
          <section className="mx-4 mt-3 rounded-2xl border border-[#E8E6E1] bg-white p-3 shadow-card">
            <h2 className="mb-1 text-sm font-semibold text-[#1F2937]">{t('sales.chart.title')}</h2>
            <RevenueChart
              series={series}
              coverageFirstDay={coverage?.firstDay ?? null}
              t={t}
              locale={locale}
            />
          </section>

          {/* ---- daily figures (the table view the chart's values live in) ---- */}
          <section className="mx-4 mt-3 overflow-hidden rounded-2xl border border-[#E8E6E1] bg-white shadow-card">
            <h2 className="border-b border-[#E8E6E1] px-3 py-2.5 text-sm font-semibold text-[#1F2937]">
              {t('sales.table.title')}
            </h2>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-[#E8E6E1] bg-[#FAF9F6] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
              <span>{t('sales.table.date')}</span>
              <span className="text-right">{t('sales.table.revenue')}</span>
              <span className="w-10 text-right">{t('sales.table.orders')}</span>
            </div>
            {rows.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">{t('sales.table.noData')}</p>
            ) : (
              rows.map((d) => {
                const beforeHistory = coverage?.firstDay != null && d.day < coverage.firstDay
                return (
                  <div
                    key={d.day}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-b border-[#ECECEC] px-3 py-2 last:border-b-0"
                  >
                    <span className="truncate text-xs text-[#1F2937]">{dayLabelLong(d.day)}</span>
                    {beforeHistory ? (
                      <span className="col-span-2 text-right text-[11px] italic text-gray-400">
                        {t('sales.table.beforeHistory')}
                      </span>
                    ) : (
                      <>
                        <span
                          className={cn(
                            'text-right text-xs font-medium tabular-nums',
                            d.revenue > 0 ? 'text-[#1F2937]' : 'text-gray-300'
                          )}
                        >
                          {formatRM(d.revenue)}
                        </span>
                        <span
                          className={cn(
                            'w-10 text-right text-xs tabular-nums',
                            d.orderCount > 0 ? 'text-[#6B7280]' : 'text-gray-300'
                          )}
                        >
                          {d.orderCount}
                        </span>
                      </>
                    )}
                  </div>
                )
              })
            )}
          </section>

          <p className="mx-4 mt-3 text-[11px] leading-relaxed text-gray-500">{t('sales.basis')}</p>
        </>
      )}
    </div>
  )
}
