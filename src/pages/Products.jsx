import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Package, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'

const PLATFORM_META = {
  Shopee: {
    badge: 'bg-orange-500/15 text-orange-600',
    chipActive: 'bg-orange-500/15 text-orange-600',
    tint: 'bg-orange-500/10',
  },
  Lazada: {
    badge: 'bg-blue-500/15 text-blue-600',
    chipActive: 'bg-blue-500/15 text-blue-600',
    tint: 'bg-blue-500/10',
  },
  TikTok: {
    badge: 'bg-gray-500/15 text-gray-600',
    chipActive: 'bg-gray-500/15 text-gray-600',
    tint: 'bg-gray-400/15',
  },
  Shopify: {
    badge: 'bg-green-500/15 text-green-600',
    chipActive: 'bg-green-500/15 text-green-600',
    tint: 'bg-green-500/10',
  },
}

const PLATFORM_FILTERS = ['All', 'Shopee', 'Lazada', 'TikTok', 'Shopify']

const STATUS_FILTERS = ['All', 'Active', 'Low Stock', 'Out of Stock']

const STATUS_BADGE = {
  Active: 'bg-green-500/15 text-green-600',
  Unlisted: 'bg-gray-500/15 text-gray-600',
  Banned: 'bg-red-500/15 text-red-600',
  Deleted: 'bg-red-500/15 text-red-600',
}

const LOW_STOCK_THRESHOLD = 10

const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
}

const SHOPEE_PRODUCT_STATUS_MAP = {
  NORMAL: 'Active',
  UNLIST: 'Unlisted',
  BANNED: 'Banned',
  DELETED: 'Deleted',
}

function mapSupabaseProduct(row) {
  const platform = PLATFORM_LABELS[row.platform] ?? row.platform ?? 'Shopee'
  const status =
    SHOPEE_PRODUCT_STATUS_MAP[row.status] ?? row.status ?? 'Active'

  return {
    id: row.id,
    platform,
    title: row.title || 'Untitled Product',
    sku: row.sku || '-',
    price: Number(row.price) || 0,
    stock: Number.isFinite(Number(row.stock)) ? Number(row.stock) : 0,
    imageUrl: row.image_url || null,
    status,
  }
}

function stockClass(stock) {
  if (stock <= 0) return 'text-red-600'
  if (stock <= LOW_STOCK_THRESHOLD) return 'text-yellow-700'
  return 'text-[#374151]'
}

function ProductThumb({ product, className }) {
  const meta = PLATFORM_META[product.platform] ?? PLATFORM_META.Shopee
  if (product.imageUrl) {
    return (
      <img
        src={product.imageUrl}
        alt={product.title}
        className={cn('shrink-0 rounded-lg object-cover', className)}
      />
    )
  }
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        meta.tint,
        className
      )}
    >
      <Package className="h-5 w-5 text-gray-400" />
    </div>
  )
}

function ProductCard({ product, onClick }) {
  const meta = PLATFORM_META[product.platform] ?? PLATFORM_META.Shopee

  return (
    <div
      onClick={() => onClick(product)}
      className="flex cursor-pointer gap-3 rounded-xl border border-[#ECECEC] bg-white p-4 shadow-sm transition-transform active:scale-[0.98]"
    >
      <ProductThumb product={product} className="h-16 w-16" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn('rounded-full px-2 py-0.5 font-medium', meta.badge)}>
            {product.platform}
          </span>
          {STATUS_BADGE[product.status] && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-medium',
                STATUS_BADGE[product.status]
              )}
            >
              {product.status}
            </span>
          )}
        </div>

        <p className="mt-2 truncate text-sm font-medium text-[#1F2937]">{product.title}</p>
        <p className="truncate font-mono text-xs text-gray-500">{product.sku}</p>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#1F2937]">
            RM {product.price.toFixed(2)}
          </span>
          <span className={cn('text-xs font-medium', stockClass(product.stock))}>
            {product.stock <= 0 ? 'Out of stock' : `${product.stock} in stock`}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function Products() {
  const [platformFilter, setPlatformFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [editForm, setEditForm] = useState({ title: '', price: '', stock: '' })
  const [saving, setSaving] = useState(false)

  const fetchProducts = useCallback(async () => {
    setLoading(true)
    // Paged: this page filters and searches client-side over the full list, so
    // a silent stop at PostgREST's 1000-row cap would make products past it
    // unfindable rather than merely unlisted.
    const { data, error } = await selectAllPaged('products.list', (from, to) =>
      supabase.from('products').select('*').order('title', { ascending: true }).range(from, to)
    )

    if (!error && data) {
      setProducts(data.map(mapSupabaseProduct))
    } else {
      setProducts([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchProducts()
  }, [fetchProducts])

  async function handleSync() {
    setSyncing(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error('You must be logged in to sync.')
        return
      }

      const res = await fetch('/api/shopee/sync-products', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      const data = await res.json()

      if (!res.ok || !data.success) {
        toast.error(data.error || 'Failed to sync products.')
        return
      }

      toast.success(`Synced ${data.synced} products!`)
      await fetchProducts()
    } catch {
      toast.error('Failed to sync products.')
    } finally {
      setSyncing(false)
    }
  }

  const platformCounts = useMemo(() => {
    const counts = { All: 0, Shopee: 0, Lazada: 0, TikTok: 0, Shopify: 0 }
    products.forEach((product) => {
      counts.All += 1
      counts[product.platform] = (counts[product.platform] ?? 0) + 1
    })
    return counts
  }, [products])

  const filteredProducts = products.filter((product) => {
    if (platformFilter !== 'All' && product.platform !== platformFilter) return false

    if (statusFilter === 'Active' && product.status !== 'Active') return false
    if (statusFilter === 'Low Stock' && !(product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD))
      return false
    if (statusFilter === 'Out of Stock' && product.stock > 0) return false

    const q = search.trim().toLowerCase()
    if (q && !product.title.toLowerCase().includes(q) && !product.sku.toLowerCase().includes(q)) {
      return false
    }
    return true
  })

  function handleCardClick(product) {
    setSelectedProduct(product)
    setEditForm({
      title: product.title,
      price: String(product.price),
      stock: String(product.stock),
    })
  }

  async function handleSave() {
    if (!selectedProduct) return

    const nextTitle = editForm.title.trim()
    const nextPrice = Number(editForm.price)
    const nextStock = Number(editForm.stock)

    if (!nextTitle) {
      toast.error('Title cannot be empty.')
      return
    }
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      toast.error('Enter a valid price.')
      return
    }
    if (!Number.isInteger(nextStock) || nextStock < 0) {
      toast.error('Enter a valid stock quantity.')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('products')
        .update({ title: nextTitle, price: nextPrice, stock: nextStock })
        .eq('id', selectedProduct.id)

      if (error) {
        toast.error('Failed to save changes.')
        return
      }

      setProducts((prev) =>
        prev.map((p) =>
          p.id === selectedProduct.id
            ? { ...p, title: nextTitle, price: nextPrice, stock: nextStock }
            : p
        )
      )
      toast.success('Product updated!')
      setSelectedProduct(null)
    } catch {
      toast.error('Failed to save changes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4">
        <div className="flex items-center justify-between pb-2">
          <h1 className="text-xl font-bold text-[#1F2937]">Products</h1>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncing}
            className="border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Sync
          </Button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto px-4 py-2">
        {PLATFORM_FILTERS.map((platform) => {
          const active = platformFilter === platform
          const activeClass =
            platform === 'All' ? 'bg-[#2563EB] text-white' : PLATFORM_META[platform].chipActive
          return (
            <button
              key={platform}
              onClick={() => setPlatformFilter(platform)}
              className={cn(
                'shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                active ? activeClass : 'bg-[#F3F4F6] text-[#6B7280]'
              )}
            >
              {platform} ({platformCounts[platform] ?? 0})
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 overflow-x-auto px-4 pb-1">
        {STATUS_FILTERS.map((status) => {
          const active = statusFilter === status
          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={cn(
                'shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                active ? 'bg-gray-200 text-[#1F2937]' : 'bg-[#F3F4F6] text-[#6B7280]'
              )}
            >
              {status}
            </button>
          )
        })}
      </div>

      <div className="px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product name or SKU"
            className="h-10 !bg-white rounded-xl border-[#E5E7EB] pl-9 pr-9 text-[#1F2937] placeholder:text-gray-400"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-[#ECECEC] bg-white p-4 shadow-sm">
              <Skeleton className="h-16 w-16 shrink-0 rounded-lg bg-gray-200" />
              <div className="flex-1">
                <Skeleton className="h-4 w-20 bg-gray-200" />
                <Skeleton className="mt-3 h-4 w-40 bg-gray-200" />
                <Skeleton className="mt-2 h-3 w-24 bg-gray-200" />
                <Skeleton className="mt-3 h-4 w-full bg-gray-200" />
              </div>
            </div>
          ))
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Package className="h-10 w-10 text-gray-300" />
            <p className="text-sm text-gray-500">
              No products yet — tap Sync to fetch your Shopee products
            </p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-500">No products found.</p>
        ) : (
          filteredProducts.map((product) => (
            <ProductCard key={product.id} product={product} onClick={handleCardClick} />
          ))
        )}
      </div>

      <Sheet
        open={!!selectedProduct}
        onOpenChange={(open) => !open && setSelectedProduct(null)}
      >
        <SheetContent
          side="bottom"
          className="w-full gap-0 rounded-t-2xl border-[#ECECEC] bg-white p-0"
        >
          {selectedProduct && (
            <>
              <SheetHeader className="border-b border-[#ECECEC] px-4 py-4">
                <SheetTitle className="flex items-center gap-2 text-base text-[#1F2937]">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      (PLATFORM_META[selectedProduct.platform] ?? PLATFORM_META.Shopee).badge
                    )}
                  >
                    {selectedProduct.platform}
                  </span>
                  Edit Product
                </SheetTitle>
              </SheetHeader>

              <div className="px-4 py-4">
                <div className="flex items-center gap-3">
                  <ProductThumb product={selectedProduct} className="h-16 w-16" />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-gray-500">
                      {selectedProduct.sku}
                    </p>
                    {STATUS_BADGE[selectedProduct.status] && (
                      <span
                        className={cn(
                          'mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_BADGE[selectedProduct.status]
                        )}
                      >
                        {selectedProduct.status}
                      </span>
                    )}
                  </div>
                </div>

                <Separator className="my-4 bg-[#ECECEC]" />

                <label className="text-xs font-medium text-[#6B7280]">Title</label>
                <Input
                  value={editForm.title}
                  onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                  className="mt-1 !bg-white border-[#E5E7EB] text-[#1F2937]"
                />

                <div className="mt-3 flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-[#6B7280]">Price (RM)</label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={editForm.price}
                      onChange={(e) => setEditForm((f) => ({ ...f, price: e.target.value }))}
                      className="mt-1 !bg-white border-[#E5E7EB] text-[#1F2937]"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs font-medium text-[#6B7280]">Stock</label>
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={editForm.stock}
                      onChange={(e) => setEditForm((f) => ({ ...f, stock: e.target.value }))}
                      className="mt-1 !bg-white border-[#E5E7EB] text-[#1F2937]"
                    />
                  </div>
                </div>
              </div>

              <SheetFooter className="flex-row gap-2 border-t border-[#ECECEC] px-4 py-4">
                <Button
                  variant="outline"
                  onClick={() => setSelectedProduct(null)}
                  className="flex-1 border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
