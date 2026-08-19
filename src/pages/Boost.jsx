import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, Package, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useDateTime } from '@/lib/i18n/datetime'
import { useTranslation } from '@/lib/i18n/I18nContext'

const MAX_SLOTS = 5

// Minutes until an item's boost slot frees up, from the absolute reboostable_at
// the cron stamped (observed_at + cool_down_second). Clamped at 0.
function minutesLeft(reboostableAt, nowMs) {
  if (!reboostableAt) return 0
  const ms = new Date(reboostableAt).getTime() - nowMs
  return ms <= 0 ? 0 : Math.ceil(ms / 60000)
}

function Thumb({ imageUrl, className }) {
  if (imageUrl) {
    return <img src={imageUrl} alt="" className={cn('shrink-0 rounded-lg object-cover', className)} />
  }
  return (
    <div className={cn('flex shrink-0 items-center justify-center rounded-lg bg-[#EE4D2D]/10', className)}>
      <Package className="h-5 w-5 text-gray-400" />
    </div>
  )
}

function StoreCard({ store, slots, rotation, onToggle, toggling, onEdit }) {
  const { t } = useTranslation()
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Re-render every 30s so the "Xm left" countdowns stay honest without a refetch.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const activeSlots = slots.filter((s) => (s.cool_down_second ?? 0) > 0)
  const externalCount = slots.filter((s) => s.externally_controlled).length
  const emptyCount = Math.max(0, MAX_SLOTS - activeSlots.length)

  return (
    <div className="rounded-xl border border-[#ECECEC] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>🏪</span>
          <span className="text-sm font-medium text-[#1F2937]">
            {store.shop_name || t('boost.unnamedStore')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {toggling && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <Switch
            checked={!!store.auto_boost_enabled}
            disabled={toggling}
            onCheckedChange={() => onToggle(store)}
          />
        </div>
      </div>

      {externalCount > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          {/* Was `slot{n > 1 ? 's are' : ' is'}` — English inflection spliced
              into JSX, which no translation can reach. Plural keys instead. */}
          <p className="text-xs text-yellow-800">
            {t('boost.externallyControlled', { count: externalCount })}
          </p>
        </div>
      )}

      <p className="mb-2 text-xs text-gray-500">
        {t('boost.slotsSummary', {
          active: activeSlots.length,
          max: MAX_SLOTS,
          rotation: rotation.length,
        })}
      </p>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {activeSlots.map((slot) => {
          const mins = minutesLeft(slot.reboostable_at, nowMs)
          return (
            <div key={slot.id} className="flex w-14 shrink-0 flex-col items-center gap-1">
              <Thumb imageUrl={slot.products?.image_url} className="h-14 w-14" />
              <span
                className={cn(
                  'text-center text-[10px]',
                  slot.externally_controlled ? 'text-yellow-600' : 'text-[#EE4D2D]'
                )}
              >
                {mins > 0 ? t('boost.minutesLeft', { mins }) : t('boost.ready')}
              </span>
            </div>
          )
        })}
        {Array.from({ length: emptyCount }).map((_, i) => (
          <div key={`empty-${i}`} className="flex w-14 shrink-0 flex-col items-center gap-1">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-[#E5E7EB]">
              <Plus className="h-4 w-4 text-gray-300" />
            </div>
            <span className="text-center text-[10px] text-gray-400">{t('boost.emptySlot')}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEdit(store)}
          className="border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6]"
        >
          {t('boost.editRotation')}
        </Button>
      </div>
    </div>
  )
}

export default function Boost() {
  const { t } = useTranslation()
  const { formatTimestamp } = useDateTime()
  const [stores, setStores] = useState([])
  const [slotsByStore, setSlotsByStore] = useState({})
  const [rotationByStore, setRotationByStore] = useState({})
  const [productsByStore, setProductsByStore] = useState({})
  const [loading, setLoading] = useState(true)
  const [togglingId, setTogglingId] = useState(null)

  const [editingStoreId, setEditingStoreId] = useState(null)
  const [productSearch, setProductSearch] = useState('')
  const [mutatingRotation, setMutatingRotation] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)

    const [storesRes, slotsRes, rotationRes, productsRes] = await Promise.all([
      supabase
        .from('stores')
        .select('id, shop_name, auto_boost_enabled')
        .eq('platform', 'shopee')
        .order('shop_name', { ascending: true }),
      supabase
        .from('boost_slots')
        .select('id, store_id, item_id, cool_down_second, reboostable_at, externally_controlled, products(title, image_url)'),
      supabase
        .from('boost_rotation')
        .select('id, store_id, product_id, position, last_boosted_at, products(id, title, image_url, price)')
        .order('position', { ascending: true }),
      supabase
        .from('products')
        .select('id, store_id, title, image_url, price, stock, status')
        .order('title', { ascending: true }),
    ])

    setStores(storesRes.data ?? [])
    setSlotsByStore(groupBy(slotsRes.data ?? [], 'store_id'))
    setRotationByStore(groupBy(rotationRes.data ?? [], 'store_id'))
    setProductsByStore(groupBy(productsRes.data ?? [], 'store_id'))
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll()
  }, [fetchAll])

  async function handleToggle(store) {
    const next = !store.auto_boost_enabled
    setTogglingId(store.id)
    try {
      const { error } = await supabase
        .from('stores')
        .update({ auto_boost_enabled: next })
        .eq('id', store.id)

      if (error) {
        toast.error(t('boost.toggleError'))
        return
      }
      setStores((prev) => prev.map((s) => (s.id === store.id ? { ...s, auto_boost_enabled: next } : s)))
      toast.success(next ? t('boost.enabledToast', { max: MAX_SLOTS }) : t('boost.disabledToast'))
    } catch {
      toast.error(t('boost.toggleError'))
    } finally {
      setTogglingId(null)
    }
  }

  const editingStore = stores.find((s) => s.id === editingStoreId) ?? null
  const editingRotation = editingStoreId ? rotationByStore[editingStoreId] ?? [] : []
  const editingProducts = editingStoreId ? productsByStore[editingStoreId] ?? [] : []
  const rotationProductIds = new Set(editingRotation.map((r) => r.product_id))

  const filteredProducts = editingProducts.filter((p) => {
    if (rotationProductIds.has(p.id)) return false
    const q = productSearch.trim().toLowerCase()
    return !q || (p.title ?? '').toLowerCase().includes(q)
  })

  async function addToRotation(product) {
    if (!editingStoreId) return
    setMutatingRotation(true)
    try {
      const position = editingRotation.length
      const { data, error } = await supabase
        .from('boost_rotation')
        .insert({ store_id: editingStoreId, product_id: product.id, position })
        .select('id, store_id, product_id, position, last_boosted_at, products(id, title, image_url, price)')
        .single()

      if (error) {
        toast.error(t('boost.addError'))
        return
      }
      setRotationByStore((prev) => ({
        ...prev,
        [editingStoreId]: [...(prev[editingStoreId] ?? []), data],
      }))
    } catch {
      toast.error(t('boost.addError'))
    } finally {
      setMutatingRotation(false)
    }
  }

  async function removeFromRotation(row) {
    setMutatingRotation(true)
    try {
      const { error } = await supabase.from('boost_rotation').delete().eq('id', row.id)
      if (error) {
        toast.error(t('boost.removeError'))
        return
      }
      setRotationByStore((prev) => ({
        ...prev,
        [row.store_id]: (prev[row.store_id] ?? []).filter((r) => r.id !== row.id),
      }))
    } catch {
      toast.error(t('boost.removeError'))
    } finally {
      setMutatingRotation(false)
    }
  }

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-[#1F2937]">⚡ {t('boost.title')}</h1>
        <p className="text-sm text-[#6B7280]">{t('boost.subtitle')}</p>
      </header>

      <div className="mx-4 my-3 rounded-xl border border-[#EE4D2D]/30 bg-[#EE4D2D]/10 p-3">
        <p className="text-xs text-[#EE4D2D]">ℹ️ {t('boost.howItWorks', { max: MAX_SLOTS })}</p>
      </div>

      <div className="flex flex-col gap-4 px-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))
        ) : stores.length === 0 ? (
          <p className="mt-8 text-center text-sm text-gray-500">{t('boost.noStores')}</p>
        ) : (
          stores.map((store) => (
            <StoreCard
              key={store.id}
              store={store}
              slots={slotsByStore[store.id] ?? []}
              rotation={rotationByStore[store.id] ?? []}
              toggling={togglingId === store.id}
              onToggle={handleToggle}
              onEdit={(s) => {
                setEditingStoreId(s.id)
                setProductSearch('')
              }}
            />
          ))
        )}
      </div>

      <Sheet open={!!editingStore} onOpenChange={(open) => !open && setEditingStoreId(null)}>
        <SheetContent
          side="bottom"
          className="!h-screen w-full gap-0 rounded-t-2xl border-[#ECECEC] bg-white p-0"
        >
          <SheetHeader className="border-b border-[#ECECEC] px-4 py-4">
            <SheetTitle className="text-[#1F2937]">
              {t('boost.rotationTitle', {
                store: editingStore?.shop_name || t('boost.unnamedStore'),
              })}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <h3 className="mb-2 text-sm font-semibold text-[#1F2937]">
              {t('boost.inRotation', { count: editingRotation.length })}
            </h3>
            {editingRotation.length === 0 ? (
              <p className="mb-2 text-xs text-gray-500">
                {t('boost.emptyRotation', { max: MAX_SLOTS })}
              </p>
            ) : (
              <div className="space-y-2">
                {editingRotation.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 rounded-xl border border-[#ECECEC] bg-white p-3 shadow-sm"
                  >
                    <Thumb imageUrl={row.products?.image_url} className="h-12 w-12" />
                    <div className="min-w-0 flex-1">
                      {/* Product title is Shopee DATA — only the empty-field
                          placeholder is translated. */}
                      <p className="truncate text-sm text-[#1F2937]">
                        {row.products?.title ?? t('boost.untitledProduct')}
                      </p>
                      {row.products?.price != null && (
                        <p className="text-xs text-[#6B7280]">RM {Number(row.products.price).toFixed(2)}</p>
                      )}
                      <p className="text-[11px] text-gray-400">
                        {row.last_boosted_at
                          ? t('boost.lastBoosted', { date: formatTimestamp(row.last_boosted_at) })
                          : t('boost.neverBoosted')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutatingRotation}
                      onClick={() => removeFromRotation(row)}
                      className="border-[#E5E7EB] text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Separator className="my-4 bg-[#ECECEC]" />

            <h3 className="mb-2 text-sm font-semibold text-[#1F2937]">{t('boost.addProduct')}</h3>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <Input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder={t('boost.searchProducts')}
                className="h-10 rounded-xl border-[#E5E7EB] pl-9 !bg-white text-[#1F2937] placeholder:text-gray-400"
              />
            </div>

            <div className="mt-3">
              {filteredProducts.length === 0 ? (
                <p className="py-6 text-center text-xs text-gray-400">
                  {editingProducts.length === 0
                    ? t('boost.noSyncedProducts')
                    : t('boost.noProductsMatch')}
                </p>
              ) : (
                filteredProducts.map((product) => (
                  <div key={product.id} className="flex items-center gap-3 border-b border-[#ECECEC] p-3">
                    <Thumb imageUrl={product.image_url} className="h-12 w-12" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[#1F2937]">
                        {product.title ?? t('boost.untitledProduct')}
                      </p>
                      {product.price != null && (
                        <p className="text-xs text-[#6B7280]">RM {Number(product.price).toFixed(2)}</p>
                      )}
                      <p className="text-xs text-gray-500">
                        {t('boost.stock')}: {product.stock ?? 0}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={mutatingRotation}
                      onClick={() => addToRotation(product)}
                      className="bg-[#EE4D2D] text-white hover:bg-[#EE4D2D]/90"
                    >
                      <Plus className="h-4 w-4" /> {t('boost.add')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function groupBy(rows, key) {
  const out = {}
  for (const row of rows) {
    ;(out[row[key]] ??= []).push(row)
  }
  return out
}
