import { supabase } from '@/lib/supabase'

// Single source of truth for every sales figure in the app.
//
// There are TWO counting rules, each defined once in Postgres and never
// re-derived here:
//
//   Sales rule     — daily_sales() / sales_orders_for_day(), both reading
//                    sales_order_rows() (supabase/sales_breakdown_migration.sql).
//                    Paid AND at least packed. Used by the Sales page.
//   Dashboard rule — todays_actionable_orders() / actionable_orders_for_day(),
//                    both reading actionable_order_rows()
//                    (supabase/actionable_orders_migration.sql). Everything
//                    except cancelled and non-COD unpaid. Used by the
//                    Dashboard's "Orders Today" / "Revenue" tiles.
//
// Both bucket by order_created_at in Malaysia time, so they can disagree on
// how much a day holds but never on which day an order belongs to. The Revenue
// breakdown page lists either rule (BREAKDOWN_BASIS below), depending on which
// page opened it.
//
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

// Groups day x store RPC rows into the { combined, byStore } shape. The
// combined series is the store_id IS NULL rows Postgres computed — NOT a sum
// of the per-store rows — so there is exactly one place the arithmetic happens.
function groupDailyRows(rows) {
  const combined = []
  const byStore = new Map()

  for (const row of rows ?? []) {
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

  const { combined, byStore } = groupDailyRows(daily)

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
  return groupDailyRows(data)
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
 * Which counting rule the Revenue breakdown lists. Each basis pairs a per-day
 * order list with the aggregate it must add up to; both RPCs of a pair read
 * the same *_order_rows() function in Postgres, so the match check is a real
 * proof rather than two filters that happen to agree.
 *
 *   sales     — opened from the Sales page: the list adds up to the Sales row.
 *   dashboard — the default: the list adds up to the Dashboard Revenue tile.
 */
export const BREAKDOWN_BASIS = {
  sales: {
    listRpc: 'sales_orders_for_day',
    fetchReport: async ({ days }) => {
      const { data, error } = await supabase.rpc('daily_sales', { p_days: days })
      if (error) throw error
      return groupDailyRows(data)
    },
  },
  dashboard: {
    listRpc: 'actionable_orders_for_day',
    fetchReport: fetchActionableOrdersReport,
  },
}
export const DEFAULT_BREAKDOWN_BASIS = 'dashboard'

/** Anything other than a known basis (missing, mistyped URL) is the default. */
export function resolveBreakdownBasis(value) {
  return Object.hasOwn(BREAKDOWN_BASIS, value) ? value : DEFAULT_BREAKDOWN_BASIS
}

/**
 * Every order the given basis counts for one KL day, plus that basis's own
 * aggregate for the day so the caller can prove the two agree.
 *
 * The filter is not reimplemented here or in the page — the list RPC and the
 * aggregate RPC share one rows function in Postgres. Bounded in the database
 * to one day (and one store, if given); nothing is fetched and filtered in JS.
 *
 * `figures` is the aggregate's number for that day (the Sales row, or the
 * Dashboard tile). It is a second, tiny query (days x (stores + 1) rows) used
 * only for the match check.
 */
export async function fetchRevenueBreakdown({ day, storeId = 'all', basis = DEFAULT_BREAKDOWN_BASIS }) {
  const { listRpc, fetchReport } = BREAKDOWN_BASIS[resolveBreakdownBasis(basis)]
  const daysBack = daysBetweenISO(day, todayKL()) + 1
  const [listRes, report] = await Promise.all([
    supabase
      .rpc(listRpc, {
        p_day: day,
        p_store_id: storeId === 'all' ? null : storeId,
      })
      .limit(BREAKDOWN_ROW_LIMIT),
    fetchReport({ days: Math.min(Math.max(daysBack, 1), REVENUE_BREAKDOWN_DAYS) }),
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
 * open it on the SAME store, day (when it has one) and counting rule instead
 * of resetting to all-stores/today/Dashboard rule. Defaults are omitted from
 * the query string — the page treats a missing `store`/`day`/`basis` as
 * all-stores/today/dashboard — which keeps a plain link clean.
 */
export function revenueBreakdownPath({ day, storeId, basis } = {}) {
  const params = new URLSearchParams()
  if (basis && basis !== DEFAULT_BREAKDOWN_BASIS) params.set('basis', basis)
  if (storeId && storeId !== 'all') params.set('store', storeId)
  if (day && day !== todayKL()) params.set('day', day)
  const query = params.toString()
  return query ? `/revenue?${query}` : '/revenue'
}
