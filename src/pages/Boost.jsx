import { useState } from 'react'
import { Pencil, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

const PRODUCTS = [
  { id: 1, name: 'LED Lightsaber RGB', price: 45, stock: 23 },
  { id: 2, name: 'Foam Drone Mini', price: 60, stock: 15 },
  { id: 3, name: 'Transformers Optimus', price: 89, stock: 8 },
  { id: 4, name: 'Fidget Spinner Pro', price: 35, stock: 42 },
  { id: 5, name: 'Transformers Bumblebee', price: 95, stock: 5 },
  { id: 6, name: 'LED Lightsaber Blue', price: 45, stock: 18 },
  { id: 7, name: 'Fidget Cube', price: 35, stock: 30 },
  { id: 8, name: 'Foam Drone XL', price: 80, stock: 7 },
]

function makeSlots(productIndexes, minutesValues) {
  return productIndexes.map((productIdx, i) => ({
    product: PRODUCTS[productIdx],
    minutesLeft: minutesValues[i],
  }))
}

const INITIAL_STORES = [
  {
    id: 1,
    name: '玩具 - Cat Play Toys',
    on: true,
    slots: makeSlots([0, 1, 2, 3, 4], [61, 61, 125, 61, 61]),
  },
  {
    id: 2,
    name: '玩具 - Meow Fun Toys',
    on: true,
    slots: makeSlots([5, 6, 7, 0, 1], [125, 61, 61, 61, 61]),
  },
  {
    id: 3,
    name: '电池水 - Kardon Shop',
    on: true,
    slots: makeSlots([2, 3, 4, 5, 6], [61, 61, 61, 61, 61]),
  },
  {
    id: 4,
    name: '电池水 - Big Hammer',
    on: false,
    slots: makeSlots([7, 0, 1, 2, 3], [0, 0, 0, 0, 0]),
  },
]

function ToggleSwitch({ on, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors',
        on ? 'bg-green-500' : 'bg-gray-300'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform',
          on && 'translate-x-5'
        )}
      />
    </button>
  )
}

function StoreCard({ store, onToggle, onEdit }) {
  return (
    <div className="rounded-xl bg-white border border-[#ECECEC] shadow-sm p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>🏪</span>
          <span className="text-sm font-medium text-[#1F2937]">{store.name}</span>
        </div>
        <ToggleSwitch on={store.on} onClick={() => onToggle(store.id)} />
      </div>

      <p className="mb-2 text-xs text-gray-500">{store.slots.length} products boosting</p>

      <div className="flex gap-2 overflow-x-auto">
        {store.slots.map((slot, i) => (
          <div key={i} className="flex shrink-0 flex-col items-center gap-1">
            <div className="h-14 w-14 shrink-0 rounded-lg bg-[#EE4D2D]/20" />
            <span className="text-center text-[10px] text-[#EE4D2D]">{slot.minutesLeft}m left</span>
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
          <Pencil /> Edit Boost
        </Button>
      </div>
    </div>
  )
}

export default function Boost() {
  const [stores, setStores] = useState(INITIAL_STORES)
  const [editingStoreId, setEditingStoreId] = useState(null)
  const [replaceIndex, setReplaceIndex] = useState(0)
  const [productSearch, setProductSearch] = useState('')

  const editingStore = stores.find((s) => s.id === editingStoreId) ?? null

  function toggleStore(id) {
    setStores((prev) => prev.map((s) => (s.id === id ? { ...s, on: !s.on } : s)))
  }

  function openEdit(store) {
    setEditingStoreId(store.id)
    setReplaceIndex(0)
    setProductSearch('')
  }

  function pickReplacement(product) {
    setStores((prev) =>
      prev.map((s) =>
        s.id === editingStoreId
          ? { ...s, slots: s.slots.map((slot, i) => (i === replaceIndex ? { ...slot, product } : slot)) }
          : s
      )
    )
  }

  const filteredProducts = PRODUCTS.filter((p) => {
    const q = productSearch.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q)
  })

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-[#1F2937]">⚡ Boost Manager</h1>
        <p className="text-sm text-[#6B7280]">Shopee product boosts</p>
      </header>

      <div className="mx-4 my-3 rounded-xl border border-[#EE4D2D]/30 bg-[#EE4D2D]/10 p-3">
        <p className="text-xs text-[#EE4D2D]">
          ℹ️ Data updates every 10 minutes. Each store boosts 5 products. Boost stops if not logged in
          for 30 days.
        </p>
      </div>

      <div className="flex flex-col gap-4 px-4">
        {stores.map((store) => (
          <StoreCard key={store.id} store={store} onToggle={toggleStore} onEdit={openEdit} />
        ))}
      </div>

      <Sheet open={!!editingStore} onOpenChange={(open) => !open && setEditingStoreId(null)}>
        <SheetContent
          side="bottom"
          className="!h-screen w-full gap-0 rounded-t-2xl border-[#ECECEC] bg-white p-0"
        >
          <SheetHeader className="border-b border-[#ECECEC] px-4 py-4">
            <SheetTitle className="text-[#1F2937]">Edit Boost - {editingStore?.name}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="space-y-3">
              {editingStore?.slots.map((slot, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-3 rounded-xl bg-white border border-[#ECECEC] shadow-sm p-3',
                    replaceIndex === i && 'ring-1 ring-[#EE4D2D]'
                  )}
                >
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-[#EE4D2D]/20" />
                  <div className="flex-1">
                    <p className="text-sm text-[#1F2937]">{slot.product.name}</p>
                    <p className="text-xs text-[#6B7280]">RM {slot.product.price.toFixed(2)}</p>
                    <p className="text-xs text-[#EE4D2D]">{slot.minutesLeft}m left</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReplaceIndex(i)}
                    className="border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6]"
                  >
                    Change
                  </Button>
                </div>
              ))}
            </div>

            <Separator className="my-4 bg-[#ECECEC]" />

            <h3 className="mb-2 text-sm font-semibold text-[#1F2937]">Add Product</h3>
            <p className="mb-2 text-xs text-gray-500">
              Replacing slot {replaceIndex + 1} — pick a product below
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <Input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search products"
                className="h-10 !bg-white rounded-xl border-[#E5E7EB] pl-9 text-[#1F2937] placeholder:text-gray-400"
              />
            </div>

            <div className="mt-3">
              {filteredProducts.map((product) => (
                <div key={product.id} className="flex items-center gap-3 border-b border-[#ECECEC] p-3">
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-[#EE4D2D]/20" />
                  <div className="flex-1">
                    <p className="text-sm text-[#1F2937]">{product.name}</p>
                    <p className="text-xs text-[#6B7280]">RM {product.price.toFixed(2)}</p>
                    <p className="text-xs text-gray-500">Stock: {product.stock}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => pickReplacement(product)}
                    className="bg-[#EE4D2D] text-white hover:bg-[#EE4D2D]/90"
                  >
                    Select
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
