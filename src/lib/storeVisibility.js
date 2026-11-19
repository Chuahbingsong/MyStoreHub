// Per-store "Hide orders" (stores.orders_hidden). A hidden store stays
// connected and keeps syncing; only its ORDERS are left out of what the app
// shows. Totals (Dashboard tiles, Sales, Revenue breakdown) are excluded in
// SQL — see supabase/store_orders_hidden_migration.sql. These helpers cover
// the direct `orders` selects, and must be applied IN THE QUERY (not after the
// fetch) so a hidden store's backlog can't eat into a paged/row-capped read.
//
// Scan deliberately does not use them: a parcel in hand must always resolve.

export function isStoreHidden(store) {
  return store?.orders_hidden === true
}

/** Ids of the hidden stores in a `stores` result (must select orders_hidden). */
export function hiddenStoreIds(stores) {
  return (stores ?? []).filter(isStoreHidden).map((s) => s.id)
}

export function visibleStores(stores) {
  return (stores ?? []).filter((s) => !isStoreHidden(s))
}

/**
 * Adds `store_id NOT IN (hidden…)` to a Supabase orders query. With nothing
 * hidden the query is returned untouched, so behaviour is byte-for-byte what
 * it was before this feature existed.
 */
export function excludeHiddenStores(query, hiddenIds) {
  if (!hiddenIds || hiddenIds.length === 0) return query
  return query.not('store_id', 'in', `(${hiddenIds.join(',')})`)
}
