import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, ShoppingBag, Package, Zap, Menu } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/I18nContext'

// `key` (not the translated label) drives the orders-badge check below, so
// switching locale never breaks it.
const TABS = [
  { key: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, path: '/dashboard' },
  { key: 'orders', labelKey: 'nav.orders', icon: ShoppingBag, path: '/orders' },
  { key: 'products', labelKey: 'nav.products', icon: Package, path: '/products' },
  { key: 'boost', labelKey: 'nav.boost', icon: Zap, path: '/boost' },
  { key: 'more', labelKey: 'nav.more', icon: Menu, path: '/settings' },
]

export default function BottomNav({ orderCount = 0 }) {
  const location = useLocation()
  const { t } = useTranslation()

  if (location.pathname === '/login') return null

  return (
    <nav className="pb-safe px-safe fixed inset-x-0 bottom-0 z-50 flex border-t border-[#ECECEC] bg-white">
      {TABS.map(({ key, labelKey, icon: Icon, path }) => {
        const isActive = location.pathname === path

        return (
          <Link
            key={path}
            to={path}
            className="flex flex-1 flex-col items-center justify-center gap-1 py-2"
          >
            <span className="relative">
              <Icon size={22} className={isActive ? 'text-[#2563EB]' : 'text-[#6B7280]'} />
              {key === 'orders' && orderCount > 0 && (
                <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
                  {orderCount > 99 ? '99+' : orderCount}
                </span>
              )}
            </span>
            <span className={`text-[11px] ${isActive ? 'font-medium text-[#2563EB]' : 'text-[#6B7280]'}`}>
              {t(labelKey)}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
