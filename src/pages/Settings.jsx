import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Check,
  ChevronRight,
  Loader2,
  LogOut,
  Package,
  Pencil,
  RefreshCw,
  ShoppingBag,
  Truck,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { getAutoSyncOrdersEnabled, setAutoSyncOrdersEnabled } from '@/lib/preferences'
import {
  isPushSupported,
  isIosNeedsInstall,
  getExistingSubscription,
  enablePush,
  disablePush,
} from '@/lib/push'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { useDateTime } from '@/lib/i18n/datetime'
import { apiUrl, describeRequestError } from '@/lib/apiBase'

const PLATFORMS = [
  {
    key: 'shopee',
    name: 'Shopee',
    dotClass: 'bg-orange-500',
    enabled: true,
  },
  {
    key: 'lazada',
    name: 'Lazada',
    dotClass: 'bg-blue-500',
    enabled: true,
  },
  {
    key: 'tiktok',
    name: 'TikTok Shop',
    dotClass: 'bg-gray-800',
    enabled: true,
  },
  {
    key: 'shopify',
    name: 'Shopify',
    dotClass: 'bg-green-500',
    enabled: false,
  },
]

export default function Settings() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t, locale, setLocale } = useTranslation()
  const { formatTimestamp } = useDateTime()
  const [user, setUser] = useState(null)
  const [stores, setStores] = useState([])
  const [loadingStores, setLoadingStores] = useState(true)
  const [connectingShopee, setConnectingShopee] = useState(false)
  const [connectingTikTok, setConnectingTikTok] = useState(false)
  const [connectingLazada, setConnectingLazada] = useState(false)
  const [syncingStoreId, setSyncingStoreId] = useState(null)
  const [syncingProductsStoreId, setSyncingProductsStoreId] = useState(null)
  const [editingStoreId, setEditingStoreId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [savingStoreId, setSavingStoreId] = useState(null)
  const [togglingAutoPackId, setTogglingAutoPackId] = useState(null)
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(() => getAutoSyncOrdersEnabled())
  // Push: source of truth is whether THIS browser currently holds a
  // subscription (read on mount). Default OFF until opted in.
  const [pushSupported] = useState(() => isPushSupported())
  const [pushNeedsIosInstall] = useState(() => isIosNeedsInstall())
  const [pushEnabled, setPushEnabled] = useState(false)
  const [togglingPush, setTogglingPush] = useState(false)

  const fetchStores = useCallback(async (userId) => {
    setLoadingStores(true)
    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .eq('user_id', userId)
      .not('platform', 'is', null)
      .order('created_at', { ascending: false })

    if (!error) {
      setStores(data ?? [])
    }
    setLoadingStores(false)
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data?.user ?? null)
      if (data?.user) {
        fetchStores(data.user.id)
      } else {
        setLoadingStores(false)
      }
    })
  }, [fetchStores])

  useEffect(() => {
    if (searchParams.get('connected') === 'shopee') {
      toast.success(t('settings.connectStore.connectedToast'))
      if (user?.id) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchStores(user.id)
      }
      searchParams.delete('connected')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, user])

  async function handleConnectShopee() {
    setConnectingShopee(true)
    try {
      const res = await fetch(apiUrl('/api/shopee/oauth?action=auth'))
      const data = await res.json()

      if (!res.ok || !data.authUrl) {
        toast.error(t('settings.connectStore.startErrorToast'))
        setConnectingShopee(false)
        return
      }

      window.location.href = data.authUrl
    } catch (err) {
      console.error('[settings] connect shopee failed', err)
      toast.error(describeRequestError(t, err, t('settings.connectStore.startErrorToast')))
      setConnectingShopee(false)
    }
  }

  // Unlike Shopee's ?action=auth (no session check at all), TikTok's requires
  // a verified session — see api/tiktok.js — so this has to fetch() with an
  // Authorization header rather than just navigating to the URL directly.
  // The callback itself renders a raw debug page rather than redirecting
  // back into the app (intentional, for verifying the OAuth exchange), so
  // there's no ?connected=tiktok toast here the way Shopee has one — the user
  // navigates back to Settings manually after reviewing the debug page.
  async function handleConnectTikTok() {
    setConnectingTikTok(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('settings.connectStore.tiktokLoginRequired'))
        setConnectingTikTok(false)
        return
      }

      const res = await fetch(apiUrl('/api/tiktok?action=auth'), {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = await res.json()

      if (!res.ok || !data.authUrl) {
        toast.error(t('settings.connectStore.tiktokStartErrorToast'))
        setConnectingTikTok(false)
        return
      }

      window.location.href = data.authUrl
    } catch (err) {
      console.error('[settings] connect tiktok failed', err)
      toast.error(describeRequestError(t, err, t('settings.connectStore.tiktokStartErrorToast')))
      setConnectingTikTok(false)
    }
  }

  // Same shape as handleConnectTikTok: Lazada's ?action=auth also requires a
  // verified session (see api/lazada.js), and its callback renders a raw
  // debug page rather than redirecting back into the app, so there's no
  // ?connected=lazada toast here either — the user navigates back to
  // Settings manually after reviewing the debug page.
  async function handleConnectLazada() {
    setConnectingLazada(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('settings.connectStore.lazadaLoginRequired'))
        setConnectingLazada(false)
        return
      }

      const res = await fetch(apiUrl('/api/lazada?action=auth'), {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = await res.json()

      if (!res.ok || !data.authUrl) {
        toast.error(t('settings.connectStore.lazadaStartErrorToast'))
        setConnectingLazada(false)
        return
      }

      window.location.href = data.authUrl
    } catch (err) {
      console.error('[settings] connect lazada failed', err)
      toast.error(describeRequestError(t, err, t('settings.connectStore.lazadaStartErrorToast')))
      setConnectingLazada(false)
    }
  }

  async function handleSyncStore(storeId) {
    setSyncingStoreId(storeId)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('settings.connectedStores.sync.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/sync?type=orders'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ store_id: storeId }),
      })
      const data = await res.json()

      if (!res.ok || !data.success) {
        toast.error(data.error || t('settings.connectedStores.sync.ordersError'))
        return
      }

      toast.success(t('settings.connectedStores.sync.ordersSuccess', { count: data.synced }))
      if (user?.id) {
        fetchStores(user.id)
      }
    } catch (err) {
      console.error('[settings] sync orders failed', err)
      toast.error(describeRequestError(t, err, t('settings.connectedStores.sync.ordersError')))
    } finally {
      setSyncingStoreId(null)
    }
  }

  async function handleSyncProductsStore(storeId) {
    setSyncingProductsStoreId(storeId)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('settings.connectedStores.sync.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/sync?type=products'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ store_id: storeId }),
      })
      const data = await res.json()

      if (!res.ok || !data.success) {
        toast.error(data.error || t('settings.connectedStores.sync.productsError'))
        return
      }

      toast.success(t('settings.connectedStores.sync.productsSuccess', { count: data.synced }))
      if (user?.id) {
        fetchStores(user.id)
      }
    } catch (err) {
      console.error('[settings] sync products failed', err)
      toast.error(describeRequestError(t, err, t('settings.connectedStores.sync.productsError')))
    } finally {
      setSyncingProductsStoreId(null)
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  function handleToggleAutoSync() {
    const next = !autoSyncEnabled
    setAutoSyncEnabledState(next)
    setAutoSyncOrdersEnabled(next)
  }

  // Initialise the push toggle from the browser's actual subscription state, so
  // it survives reloads and reflects reality (e.g. permission revoked in
  // browser settings) rather than a stored flag.
  useEffect(() => {
    if (!pushSupported) return
    getExistingSubscription()
      .then((sub) => {
        setPushEnabled(!!sub)
      })
      .catch(() => {})
  }, [pushSupported])

  async function handleTogglePush() {
    if (!user?.id) return
    const next = !pushEnabled
    setTogglingPush(true)
    try {
      if (next) {
        const { ok, reason } = await enablePush(user.id)
        if (!ok) {
          toast.error(
            reason === 'denied'
              ? t('settings.push.deniedToast')
              : reason === 'unsupported'
                ? t('settings.push.unsupported')
                : t('settings.push.errorToast')
          )
          return
        }
        setPushEnabled(true)
        toast.success(t('settings.push.enabledToast'))
      } else {
        const { ok } = await disablePush()
        if (!ok) {
          toast.error(t('settings.push.errorToast'))
          return
        }
        setPushEnabled(false)
        toast.success(t('settings.push.disabledToast'))
      }
    } finally {
      setTogglingPush(false)
    }
  }

  // Auto-pack is per-store and lives in Supabase (not localStorage like the
  // auto-sync toggle above) because cron runs server-side and has no access
  // to this browser's localStorage — it reads stores.auto_pack_enabled
  // directly.
  async function handleToggleAutoPack(store) {
    const next = !store.auto_pack_enabled
    setTogglingAutoPackId(store.id)
    try {
      const { error } = await supabase
        .from('stores')
        .update({ auto_pack_enabled: next })
        .eq('id', store.id)

      if (error) {
        toast.error(t('settings.connectedStores.autoPack.errorToast'))
        return
      }

      setStores((prev) =>
        prev.map((s) => (s.id === store.id ? { ...s, auto_pack_enabled: next } : s))
      )
      toast.success(
        next
          ? t('settings.connectedStores.autoPack.enabledToast')
          : t('settings.connectedStores.autoPack.disabledToast')
      )
    } catch {
      toast.error(t('settings.connectedStores.autoPack.errorToast'))
    } finally {
      setTogglingAutoPackId(null)
    }
  }

  function handleStartEditName(store) {
    setEditingStoreId(store.id)
    setEditingName(store.shop_name || '')
  }

  function handleCancelEditName() {
    setEditingStoreId(null)
    setEditingName('')
  }

  async function handleSaveName(store) {
    const trimmed = editingName.trim()
    setSavingStoreId(store.id)
    try {
      const { error } = await supabase
        .from('stores')
        .update({ shop_name: trimmed })
        .eq('id', store.id)

      if (error) {
        toast.error(t('settings.connectedStores.nameErrorToast'))
        return
      }

      setStores((prev) =>
        prev.map((s) => (s.id === store.id ? { ...s, shop_name: trimmed } : s))
      )
      toast.success(t('settings.connectedStores.nameUpdatedToast'))
      setEditingStoreId(null)
      setEditingName('')
    } catch {
      toast.error(t('settings.connectedStores.nameErrorToast'))
    } finally {
      setSavingStoreId(null)
    }
  }

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-[#1F2937]">{t('settings.title')}</h1>
      </header>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.language.title')}</h2>
        <div className="inline-flex rounded-xl border border-[#ECECEC] bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setLocale('en')}
            aria-pressed={locale === 'en'}
            className={cn(
              'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors',
              locale === 'en' ? 'bg-[#2563EB] text-white' : 'text-[#6B7280] hover:text-[#1F2937]'
            )}
          >
            {t('settings.language.en')}
          </button>
          <button
            type="button"
            onClick={() => setLocale('zh-CN')}
            aria-pressed={locale === 'zh-CN'}
            className={cn(
              'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors',
              locale === 'zh-CN' ? 'bg-[#2563EB] text-white' : 'text-[#6B7280] hover:text-[#1F2937]'
            )}
          >
            {t('settings.language.zh')}
          </button>
        </div>
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.shipping.title')}</h2>
        <button
          type="button"
          onClick={() => navigate('/shipping')}
          className="flex w-full items-center gap-3 rounded-xl border border-[#ECECEC] bg-white p-4 text-left shadow-sm transition-colors hover:bg-[#FAFAF9]"
        >
          <Truck className="h-5 w-5 shrink-0 text-[#6B7280]" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[#1F2937]">
              {t('settings.shipping.label')}
            </span>
            <span className="block text-xs text-[#6B7280]">
              {t('settings.shipping.description')}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-[#9CA3AF]" />
        </button>
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.connectedStores.title')}</h2>

        {loadingStores ? (
          <div className="flex items-center justify-center rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4">
            <Loader2 className="h-5 w-5 animate-spin text-[#6B7280]" />
          </div>
        ) : stores.length === 0 ? (
          <div className="rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4 text-center text-sm text-[#6B7280]">
            {t('settings.connectedStores.empty')}
          </div>
        ) : (
          <div className="space-y-2">
            {stores.map((store) => {
              const platform = PLATFORMS.find((p) => p.key === store.platform)
              // Auto-pack and the Sync buttons below both drive Shopee-only
              // endpoints/columns — showing them for a TikTok or Lazada mirror
              // row (store.platform !== 'shopee') would either no-op
              // misleadingly (auto_pack_enabled) or 404 against
              // /api/shopee/sync?type=... ("No matching Shopee store found")
              // when clicked.
              const isShopee = store.platform === 'shopee'
              const isEditing = editingStoreId === store.id
              const isSaving = savingStoreId === store.id
              return (
                <div key={store.id} className="rounded-xl bg-white border border-[#ECECEC] shadow-sm p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold text-white',
                          platform?.dotClass ?? 'bg-gray-500'
                        )}
                      >
                        {platform?.name ?? store.platform}
                      </span>
                      {isEditing ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <input
                            autoFocus
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveName(store)
                              if (e.key === 'Escape') handleCancelEditName()
                            }}
                            disabled={isSaving}
                            className="min-w-0 flex-1 rounded-md border border-[#E5E7EB] px-2 py-1 text-sm text-[#1F2937] focus:outline-none focus:ring-1 focus:ring-[#2563EB]"
                          />
                          <button
                            type="button"
                            aria-label={t('settings.connectedStores.editNameSaveAria')}
                            onClick={() => handleSaveName(store)}
                            disabled={isSaving}
                            className="shrink-0 rounded-md p-1 text-green-600 hover:bg-green-500/10"
                          >
                            {isSaving ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label={t('settings.connectedStores.editNameCancelAria')}
                            onClick={handleCancelEditName}
                            disabled={isSaving}
                            className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-500/10"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-sm font-medium text-[#1F2937]">
                            {store.shop_name || store.shop_id}
                          </span>
                          <button
                            type="button"
                            aria-label={t('settings.connectedStores.editNameEditAria')}
                            onClick={() => handleStartEditName(store)}
                            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-500/10 hover:text-gray-600"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-green-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      {t('settings.connectedStores.connected')}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#6B7280]">
                    {t('settings.connectedStores.shopId', { id: store.shop_id })}
                  </p>
                  {store.last_synced_at && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      {t('settings.connectedStores.lastSynced', {
                        date: formatTimestamp(store.last_synced_at),
                      })}
                    </p>
                  )}
                  {isShopee && (
                    <div className="mt-3 flex items-center justify-between rounded-lg bg-[#F9FAFB] px-3 py-2">
                      <div>
                        <p className="text-xs font-medium text-[#1F2937]">
                          {t('settings.connectedStores.autoPack.title')}
                        </p>
                        <p className="text-[11px] text-[#6B7280]">
                          {t('settings.connectedStores.autoPack.description')}
                        </p>
                      </div>
                      <Switch
                        checked={!!store.auto_pack_enabled}
                        disabled={togglingAutoPackId === store.id}
                        onCheckedChange={() => handleToggleAutoPack(store)}
                        aria-label={t('settings.connectedStores.autoPack.toggleAria', {
                          name: store.shop_name || store.shop_id,
                        })}
                      />
                    </div>
                  )}
                  {isShopee ? (
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSyncStore(store.id)}
                        disabled={syncingStoreId === store.id}
                        className="flex-1 border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
                      >
                        {syncingStoreId === store.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('settings.connectedStores.sync.syncing')}
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4" />
                            {t('settings.connectedStores.sync.ordersButton')}
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSyncProductsStore(store.id)}
                        disabled={syncingProductsStoreId === store.id}
                        className="flex-1 border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
                      >
                        {syncingProductsStoreId === store.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('settings.connectedStores.sync.syncing')}
                          </>
                        ) : (
                          <>
                            <Package className="h-4 w-4" />
                            {t('settings.connectedStores.sync.productsButton')}
                          </>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-gray-400">{t('settings.connectedStores.sync.notSupported')}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.connectStore.title')}</h2>
        <div className="space-y-2">
          {PLATFORMS.map((platform) => (
            <div
              key={platform.key}
              className="flex items-center justify-between rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4"
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full',
                    platform.dotClass
                  )}
                >
                  <ShoppingBag className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[#1F2937]">{platform.name}</p>
                  {!platform.enabled && (
                    <p className="text-xs text-gray-500">{t('settings.connectStore.comingSoon')}</p>
                  )}
                </div>
              </div>

              {platform.key === 'shopee' ? (
                <Button
                  size="sm"
                  onClick={handleConnectShopee}
                  disabled={connectingShopee}
                  className="bg-orange-500 text-white hover:bg-orange-500/90"
                >
                  {connectingShopee ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('settings.connectStore.connect')
                  )}
                </Button>
              ) : platform.key === 'tiktok' ? (
                <Button
                  size="sm"
                  onClick={handleConnectTikTok}
                  disabled={connectingTikTok}
                  className="bg-gray-800 text-white hover:bg-gray-800/90"
                >
                  {connectingTikTok ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('settings.connectStore.connect')
                  )}
                </Button>
              ) : platform.key === 'lazada' ? (
                <Button
                  size="sm"
                  onClick={handleConnectLazada}
                  disabled={connectingLazada}
                  className="bg-blue-500 text-white hover:bg-blue-500/90"
                >
                  {connectingLazada ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('settings.connectStore.connect')
                  )}
                </Button>
              ) : (
                <Button size="sm" disabled>
                  {t('settings.connectStore.connect')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.orders.title')}</h2>
        <div className="flex items-center justify-between rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4">
          <div>
            <p className="text-sm font-medium text-[#1F2937]">{t('settings.orders.autoSyncLabel')}</p>
            <p className="mt-0.5 text-xs text-[#6B7280]">{t('settings.orders.autoSyncDescription')}</p>
          </div>
          <Switch
            checked={autoSyncEnabled}
            onCheckedChange={handleToggleAutoSync}
            aria-label={t('settings.orders.autoSyncAria')}
          />
        </div>
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.push.title')}</h2>
        <div className="rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[#1F2937]">{t('settings.push.label')}</p>
              <p className="mt-0.5 text-xs text-[#6B7280]">{t('settings.push.description')}</p>
            </div>
            {pushSupported ? (
              <Switch
                checked={pushEnabled}
                disabled={togglingPush}
                onCheckedChange={handleTogglePush}
                aria-label={t('settings.push.toggleAria')}
              />
            ) : null}
          </div>
          {!pushSupported && (
            <p className="mt-3 rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#6B7280]">
              {pushNeedsIosInstall ? t('settings.push.iosHint') : t('settings.push.unsupported')}
            </p>
          )}
        </div>
      </section>

      <section className="px-4 py-3">
        <h2 className="mb-2 font-semibold text-[#1F2937]">{t('settings.account.title')}</h2>
        <div className="rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4">
          <p className="text-sm text-[#6B7280]">{t('settings.account.loggedInAs')}</p>
          <p className="mb-4 truncate text-sm font-medium text-[#1F2937]">
            {user?.email ?? '—'}
          </p>
          <Button
            variant="destructive"
            onClick={handleLogout}
            className="w-full bg-red-500/10 text-red-600 hover:bg-red-500/20"
          >
            <LogOut className="h-4 w-4" />
            {t('settings.account.logout')}
          </Button>
        </div>
      </section>
    </div>
  )
}
