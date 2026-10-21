import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { apiUrl } from '@/lib/apiBase'

// Lazada refresh tokens die ~30 days after the shop is authorized, however
// often they're refreshed, so the seller has to reconnect monthly. This feeds
// the warning banner on Settings and Dashboard (LazadaTokenBanner) and the
// per-shop badge in Settings' store list. lazada_shops is server-only (RLS,
// no policies), hence the API round trip instead of a supabase select.
export const LAZADA_TOKEN_HEALTH_QUERY_KEY = ['lazadaTokenHealth']

async function fetchLazadaTokenHealth() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return []

  const res = await fetch(apiUrl('/api/lazada?action=status'), {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`Lazada status request failed (${res.status})`)

  const data = await res.json()
  return data.shops ?? []
}

/**
 * Returns `{ shops, byStoreId }`. Each shop is { store_id, shop_name,
 * refresh_token_expires_at, status } with status 'ok' | 'expiring' |
 * 'disconnected' — the server derives it, so the 5-day window lives in one
 * place (LAZADA_EXPIRY_WARNING_MS in api/_lib/lazada.js).
 */
export function useLazadaTokenHealth() {
  const { data: shops = [] } = useQuery({
    queryKey: LAZADA_TOKEN_HEALTH_QUERY_KEY,
    queryFn: fetchLazadaTokenHealth,
  })

  const byStoreId = new Map(shops.map((shop) => [shop.store_id, shop]))
  return { shops, byStoreId }
}
