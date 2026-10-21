import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { formatDateTime } from '@/lib/i18n/datetime'
import { useLazadaTokenHealth } from '@/lib/lazadaTokenHealth'

/**
 * Warns before (amber, from 5 days out) and after (red) a Lazada shop's
 * refresh token expires, naming each shop and its date. Renders nothing while
 * every shop is healthy.
 *
 * Settings passes `onReconnect` (its handleConnectLazada) so the banner can
 * start the flow directly; Dashboard leaves it out and links to Settings.
 */
export default function LazadaTokenBanner({ onReconnect, reconnecting = false, className }) {
  const { t, locale } = useTranslation()
  const navigate = useNavigate()
  const { shops } = useLazadaTokenHealth()

  const disconnected = shops.filter((shop) => shop.status === 'disconnected')
  const expiring = shops.filter((shop) => shop.status === 'expiring')
  if (disconnected.length === 0 && expiring.length === 0) return null

  const isDisconnected = disconnected.length > 0
  const tone = isDisconnected
    ? { box: 'border-red-300 bg-red-50', icon: 'text-red-600', title: 'text-red-900', text: 'text-red-800' }
    : { box: 'border-amber-300 bg-amber-50', icon: 'text-amber-600', title: 'text-amber-900', text: 'text-amber-800' }
  const Icon = isDisconnected ? Unplug : AlertTriangle

  const shopLine = (shop, key) =>
    shop.refresh_token_expires_at
      ? t(`lazadaTokenBanner.${key}`, {
          shop: shop.shop_name,
          date: formatDateTime(locale, shop.refresh_token_expires_at),
        })
      : t('lazadaTokenBanner.reconnectRequiredShop', { shop: shop.shop_name })

  return (
    <div role="alert" className={cn('rounded-xl border p-3', tone.box, className)}>
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.icon)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-semibold', tone.title)}>
            {t(isDisconnected ? 'lazadaTokenBanner.disconnectedTitle' : 'lazadaTokenBanner.expiringTitle')}
          </p>
          <ul className={cn('mt-1 space-y-0.5 text-xs', tone.text)}>
            {disconnected.map((shop) => (
              <li key={shop.store_id ?? shop.seller_id}>{shopLine(shop, 'expiredShop')}</li>
            ))}
            {expiring.map((shop) => (
              <li key={shop.store_id ?? shop.seller_id}>{shopLine(shop, 'expiringShop')}</li>
            ))}
          </ul>
          <p className={cn('mt-1.5 text-xs', tone.text)}>{t('lazadaTokenBanner.hint')}</p>
          <div className="mt-2">
            {onReconnect ? (
              <Button size="sm" onClick={onReconnect} disabled={reconnecting}>
                {t('lazadaTokenBanner.reconnect')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => navigate('/settings')}>
                {t('lazadaTokenBanner.openSettings')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
