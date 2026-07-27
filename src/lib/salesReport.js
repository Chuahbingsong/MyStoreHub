import { supabase } from '@/lib/supabase'

// Single source of truth for every sales figure in the app.
//
// Both the Sales page and the Dashboard's revenue tile read through here, so
// "Today" on the Dashboard and the last bar on the Sales chart are literally
// the same number from the same query — they cannot drift apart by using
// different timezones, different status filters, or different date fields.
//
// The aggregation itself happens in Postgres (supabase/sales_reporting_migration.sql).
// Nothing in this file sums orders: a client-side sum over `orders` would hit
// PostgREST's silent 1,000-row cap and quietly under-count revenue, which is
// the one failure mode a revenue report must not have. The RPC returns at most
// days x (stores + 1) rows — about 150.

export const SALES_WINDOW_DAYS = 30

// Mirrors the status list inside daily_sales(). Exported for display only —
// the filter that actually runs is the one in SQL. If these ever need to
// change, SQL is the source of truth and this follows it.
export const COUNTED_STATUSES = [
  'PROCESSED',
  'SHIPPED',
  'TO_CONFIRM_RECEIVE',
  'COMPLETED',
  'RETRY_SHIP',
]

/** KL calendar day for "now", as YYYY-MM-DD. */
export function todayKL(nowMs = Date.now()) {
  // Shifting by +8h and reading the UTC date gives the Malaysia calendar day.
  // Malaysia has had no DST since 1935, so a fixed offset is safe here; the
  // SQL side still uses the named zone, which is the authoritative bucketing.
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export function addDaysISO(isoDay, delta) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * Fetches the daily series plus history coverage in one round trip.
 *
 * Returns rows already grouped: `byStore` maps store_id -> day -> figures, and
 * `combined` is the store_id IS NULL series Postgres computed. The combined
 * series is NOT re-derived here by summing the per-store rows — it comes back
 * pre-aggregated so there is exactly one place the arithmetic happens.
 */
export async function fetchSalesReport({ days = SALES_WINDOW_DAYS } = {}) {
  const [{ data: daily, error: dailyError }, { data: coverage, error: coverageError }] =
    await Promise.all([
      supabase.rpc('daily_sales', { p_days: days }),
      supabase.rpc('sales_coverage'),
    ])

  if (dailyError) throw dailyError
  if (coverageError) throw coverageError

  const combined = []
  const byStore = new Map()

  for (const row of daily ?? []) {
    const entry = {
      day: row.day,
      revenue: Number(row.revenue) || 0,
      orderCount: Number(row.order_count) || 0,
    }
    if (row.store_id == null) {
      combined.push(entry)
    } else {
      if (!byStore.has(row.store_id)) byStore.set(row.store_id, [])
      byStore.get(row.store_id).push(entry)
    }
  }

  combined.sort((a, b) => a.day.localeCompare(b.day))
  for (const series of byStore.values()) series.sort((a, b) => a.day.localeCompare(b.day))

  const coverageByStore = new Map()
  let coverageAll = null
  for (const row of coverage ?? []) {
    const entry = {
      firstDay: row.first_order_day,
      lastDay: row.last_order_day,
      orderCount: Number(row.order_count) || 0,
    }
    if (row.store_id == null) coverageAll = entry
    else coverageByStore.set(row.store_id, entry)
  }

  return { combined, byStore, coverageAll, coverageByStore }
}

/** The series for a given store id, or the pre-aggregated combined series. */
export function seriesFor(report, storeId) {
  if (!report) return []
  return storeId === 'all' ? report.combined : (report.byStore.get(storeId) ?? [])
}

export function coverageFor(report, storeId) {
  if (!report) return null
  return storeId === 'all' ? report.coverageAll : (report.coverageByStore.get(storeId) ?? null)
}

/** Figures for one specific KL day, or zeros when that day isn't in the window. */
export function figuresForDay(series, isoDay) {
  const hit = series.find((d) => d.day === isoDay)
  return hit ?? { day: isoDay, revenue: 0, orderCount: 0 }
}

export function formatRM(value) {
  return `RM ${(Number(value) || 0).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
