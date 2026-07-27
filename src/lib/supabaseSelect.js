// Client-side guard against PostgREST's silent 1000-row response cap.
// Mirrors api/_lib/supabaseSelect.js — see that file for the full rationale.
//
// The short version: an unbounded select that hits the cap returns exactly
// 1000 rows with no error and no signal, so a truncated result is
// indistinguishable from a complete one. That is how the Orders page came to
// silently omit 244 orders while looking perfectly healthy.

export const POSTGREST_MAX_ROWS = 1000

/**
 * Fetches every row matching a query by paging with .range() until a short
 * page proves the end was reached.
 *
 * buildQuery(from, to) MUST return a FRESH PostgREST builder each call —
 * builders are single-use and mutate when awaited.
 *
 * Returns { data, error, truncated }. `truncated` means the ceiling was hit
 * and the result is INCOMPLETE — surface that to the user rather than
 * rendering a partial list as if it were whole.
 */
export async function selectAllPaged(label, buildQuery, options = {}) {
  const { pageSize = POSTGREST_MAX_ROWS, maxRows = 20_000 } = options
  const all = []

  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1)
    if (error) return { data: null, error, truncated: false }

    const page = data ?? []
    all.push(...page)

    // A short page is the only reliable end-of-results signal.
    if (page.length < pageSize) return { data: all, error: null, truncated: false }
  }

  console.error(
    `[select] ${label}: reached the ${maxRows}-row ceiling while paging. ` +
      `The list shown is INCOMPLETE.`
  )
  return { data: all, error: null, truncated: true }
}

/**
 * For selects expected to stay well under the cap. Returns true (and logs) if
 * the result came back exactly at it, which always means silent truncation.
 */
export function warnIfAtCap(label, rows, cap = POSTGREST_MAX_ROWS) {
  const n = rows?.length ?? 0
  if (n < cap) return false

  console.error(
    `[select] ${label}: returned ${n} rows, exactly PostgREST's ${cap}-row cap. ` +
      `This result is almost certainly SILENTLY TRUNCATED — bound it or use selectAllPaged().`
  )
  return true
}
