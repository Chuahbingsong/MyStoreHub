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

// Only needs today + yesterday for the Dashboard tile pair below.
export const ACTIONABLE_ORDERS_WINDOW_DAYS = 2

/**
 * Fetches the order set behind the Dashboard's "Orders Today" and "Revenue"
 * tiles: ALL of today's (and yesterday's) orders EXCEPT cancelled orders and
 * unpaid orders that aren't Cash on Delivery. "Today" is keyed off
 * order_created_at (Malaysia time) — the day the order was PLACED, so it means
 * orders received today, not orders paid today. See
 * supabase/actionable_orders_migration.sql for the exact filter and the
 * payment_method strings it matches.
 *
 * Deliberately a DIFFERENT rule from fetchSalesReport()/daily_sales() above —
 * this is not a revenue-recognition figure, it includes money not yet
 * received (unpaid COD), and must never be folded into the 30-day Sales
 * trend. Today and Yesterday are both read from this one query so the tile's
 * two lines can't disagree with each other either.
 *
 * Same response shape as fetchSalesReport() (minus coverage, which this
 * doesn't need), so it works with seriesFor()/figuresForDay() unchanged.
 */
export async function fetchActionableOrdersReport({ days = ACTIONABLE_ORDERS_WINDOW_DAYS } = {}) {
  const { data, error } = await supabase.rpc('todays_actionable_orders', { p_days: days })
  if (error) throw error

  const combined = []
  const byStore = new Map()

  for (const row of data ?? []) {
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

  return { combined, byStore }
}

// The Revenue breakdown reads at most this far back — the same 30-day cap
// todays_actionable_orders() enforces, and SALES_WINDOW_DAYS above.
export const REVENUE_BREAKDOWN_DAYS = 30

/** Whole days from `fromDay` to `toDay` (both YYYY-MM-DD), UTC-safe. */
export function daysBetweenISO(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000)
}

// PostgREST silently truncates an RPC result at its max-rows setting. Stating
// the ceiling here makes the bound explicit; the reconciliation below turns a
// hit into a visible warning instead of a quietly short list.
const BREAKDOWN_ROW_LIMIT = 1000

/**
 * Every order counted in the Dashboard Revenue figure for one KL day, plus the
 * tile's own aggregate for that day so the caller can prove the two agree.
 *
 * The list comes from actionable_orders_for_day() — the same
 * actionable_order_rows() the tile's todays_actionable_orders() sums — so the
 * filter is not reimplemented here or in the page. Bounded in the database to
 * one day (and one store, if given); nothing is fetched and filtered in JS.
 *
 * `figures` is the tile's number for that day, read through the same
 * fetchActionableOrdersReport() the Dashboard uses. It is a second, tiny query
 * (days x (stores + 1) rows) used only for the match check.
 */
export async function fetchRevenueBreakdown({ day, storeId = 'all' }) {
  const daysBack = daysBetweenISO(day, todayKL()) + 1
  const [listRes, report] = await Promise.all([
    supabase
      .rpc('actionable_orders_for_day', {
        p_day: day,
        p_store_id: storeId === 'all' ? null : storeId,
      })
      .limit(BREAKDOWN_ROW_LIMIT),
    fetchActionableOrdersReport({ days: Math.min(Math.max(daysBack, 1), REVENUE_BREAKDOWN_DAYS) }),
  ])
  if (listRes.error) throw listRes.error

  const orders = (listRes.data ?? []).map((row) => ({
    id: row.order_id,
    storeId: row.store_id,
    platform: row.platform,
    shopName: row.shop_name,
    platformOrderId: row.platform_order_id,
    status: row.order_status,
    amount: Number(row.amount) || 0,
    createdAt: row.order_created_at,
  }))

  return {
    orders,
    figures: figuresForDay(seriesFor(report, storeId), day),
  }
}

/**
 * URL of the Revenue breakdown page for a given view, so the Sales page can
 * open it on the SAME store (and day, when it has one) instead of resetting to
 * all-stores/today. Defaults are omitted from the query string — the page
 * treats a missing `store`/`day` as all-stores/today — which keeps a plain
 * link clean.
 */
export function revenueBreakdownPath({ day, storeId } = {}) {
  const params = new URLSearchParams()
  if (storeId && storeId !== 'all') params.set('store', storeId)
  if (day && day !== todayKL()) params.set('day', day)
  const query = params.toString()
  return query ? `/revenue?${query}` : '/revenue'
}
