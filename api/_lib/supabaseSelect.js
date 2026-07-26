// Guards against PostgREST's silent 1000-row response cap.
//
// A select with no explicit bound does NOT error when it hits the cap — it
// returns exactly 1000 rows and no indication that more exist. That makes a
// truncated result byte-for-byte indistinguishable from a complete one, which
// is how `orders` ended up 244 rows short in the UI and how flash_sale_items
// silently re-fetched immutable sessions on every cron tick.
//
// Two tools, and every unbounded select should use one of them:
//   selectAllPaged  — you genuinely need every row: pages past the cap.
//   warnIfAtCap     — you expect to stay well under it: screams if you didn't.

// PostgREST's default max-rows. Not configurable from the client, so it is the
// ceiling on ANY single response regardless of what .range() asks for.
export const POSTGREST_MAX_ROWS = 1000;

/**
 * Fetches every row matching a query by paging with .range() until a short
 * page proves the end was reached.
 *
 * buildQuery(from, to) MUST return a FRESH PostgREST builder on each call —
 * builders are single-use and mutate when awaited, so reusing one silently
 * returns the first page forever.
 *
 * Returns { data, error, truncated }. `truncated` is true only if maxRows was
 * reached, which means the result is incomplete and the caller must treat it
 * as untrustworthy rather than as a complete answer.
 */
export async function selectAllPaged(label, buildQuery, options = {}) {
  const { pageSize = POSTGREST_MAX_ROWS, maxRows = 100_000 } = options;
  const all = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) return { data: null, error, truncated: false };

    const page = data ?? [];
    all.push(...page);

    // A page shorter than requested is the only reliable end-of-results
    // signal — a full page might be the last one, or might not.
    if (page.length < pageSize) return { data: all, error: null, truncated: false };
  }

  console.error(
    `[select] ${label}: reached the ${maxRows}-row ceiling while paging. ` +
      `The result is INCOMPLETE — treat it as unreliable, do not act on it as a full set.`
  );
  return { data: all, error: null, truncated: true };
}

/**
 * For selects expected to stay well under the cap. Logs loudly if the result
 * came back exactly at it, which always means silent truncation.
 *
 * Returns true when truncation was detected, so a caller that can fail safe
 * has something to branch on rather than only a log line.
 */
export function warnIfAtCap(label, rows, cap = POSTGREST_MAX_ROWS) {
  const n = rows?.length ?? 0;
  if (n < cap) return false;

  console.error(
    `[select] ${label}: returned ${n} rows, exactly PostgREST's ${cap}-row cap. ` +
      `This result is almost certainly SILENTLY TRUNCATED — bound the query with ` +
      `.range()/.limit() or switch it to selectAllPaged().`
  );
  return true;
}
