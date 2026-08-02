import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Loader2, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import PrintAwbConfirmDialog from '@/components/PrintAwbConfirmDialog'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'
import { apiUrl, describeRequestError } from '@/lib/apiBase'
import {
  downloadAwbResponse,
  downloadPdf,
  describeFailedOrders,
  logPrintAwbFailure,
  printAwbErrorMessage,
  slugify,
} from '@/lib/awb'

// Raw Shopee statuses for orders still awaiting handover, i.e. the ones that
// still need a label. SHIPPED/COMPLETED/CANCELLED are already out the door.
const PRINTABLE_STATUSES = ['READY_TO_SHIP', 'PROCESSED']

const UNKNOWN_COURIER = 'Unknown courier'

const PLATFORM_BADGE = {
  shopee: 'bg-orange-500/15 text-orange-600',
  lazada: 'bg-blue-500/15 text-blue-600',
  tiktok: 'bg-gray-500/15 text-gray-600',
  shopify: 'bg-green-500/15 text-green-600',
}

const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
}

function groupKey(storeId, courier) {
  return `${storeId}::${courier}`
}

/**
 * Shopee cannot put different logistics channels in one document, so a
 * printable batch is exactly one store + one courier.
 */
function buildSections(orders, storesById) {
  const byStore = new Map()

  orders.forEach((order) => {
    const storeId = order.store_id
    const courier = order.courier_name || UNKNOWN_COURIER

    if (!byStore.has(storeId)) byStore.set(storeId, new Map())
    const byCourier = byStore.get(storeId)

    if (!byCourier.has(courier)) byCourier.set(courier, [])
    byCourier.get(courier).push(order)
  })

  return [...byStore.entries()].map(([storeId, byCourier]) => {
    const store = storesById[storeId]
    return {
      storeId,
      storeName: store?.shop_name || (store?.shop_id ? `Shop ${store.shop_id}` : 'Unknown store'),
      shopId: store?.shop_id ?? null,
      platform: store?.platform ?? 'shopee',
      groups: [...byCourier.entries()].map(([courier, groupOrders]) => ({
        key: groupKey(storeId, courier),
        storeId,
        courier,
        isUnknownCourier: courier === UNKNOWN_COURIER,
        orders: groupOrders,
        orderSns: groupOrders.map((o) => o.platform_order_id),
      })),
    }
  })
}

function GroupCard({ section, group, printing, printed, expanded, onToggle, onPrint }) {
  const count = group.orders.length

  return (
    <div
      className={cn(
        'rounded-xl border bg-white p-4 shadow-sm transition-colors',
        printed ? 'border-green-500/40 bg-green-500/[0.03]' : 'border-[#ECECEC]'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-[#1F2937]">{group.courier}</p>
            {group.isUnknownCourier && (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            )}
          </div>

          <button
            onClick={() => onToggle(group.key)}
            className="mt-0.5 flex items-center gap-1 text-xs text-[#6B7280]"
          >
            {count} order{count === 1 ? '' : 's'}
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
            />
          </button>

          {group.isUnknownCourier && (
            <p className="mt-1 text-[11px] text-amber-600">
              No courier recorded — these may span channels and print as separate files.
            </p>
          )}
        </div>

        {printed ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-700">
            <Check className="h-3.5 w-3.5" /> Printed
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() => onPrint(section, group)}
            disabled={printing}
            className="shrink-0 bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            {printing ? 'Printing...' : 'Print'}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[#F3F4F6] pt-3">
          {group.orders.map((order) => (
            <span
              key={order.platform_order_id}
              className="rounded bg-[#F3F4F6] px-1.5 py-0.5 font-mono text-[10px] text-[#6B7280]"
            >
              #{order.platform_order_id}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function BulkPrint() {
  const navigate = useNavigate()
  const [sections, setSections] = useState([])
  const [loading, setLoading] = useState(true)
  const [printingKey, setPrintingKey] = useState(null)
  const [printedKeys, setPrintedKeys] = useState(new Set())
  const [expandedKeys, setExpandedKeys] = useState(new Set())
  // Groups printed in this session are kept on screen with a ✓ state even
  // though awb_printed now excludes them from the query.
  const [printedSections, setPrintedSections] = useState([])
  const [printConfirm, setPrintConfirm] = useState(null) // { section, group } | null

  const fetchData = useCallback(async () => {
    const [ordersRes, storesRes] = await Promise.all([
      // Paged: a large unprinted backlog would otherwise stop at the 1000-row
      // cap and silently omit AWBs from a print run — the worst place for a
      // short list, since the operator has no way to tell one is missing.
      selectAllPaged('bulkPrint.orders', (from, to) =>
        supabase
          .from('orders')
          .select('*')
          .in('order_status', PRINTABLE_STATUSES)
          .not('platform_order_id', 'is', null)
          // Tolerates legacy rows where the column is null rather than false.
          .not('awb_printed', 'is', true)
          .order('order_created_at', { ascending: false })
          .range(from, to)
      ),
      supabase.from('stores').select('id, shop_id, shop_name, platform'),
    ])

    if (ordersRes.error) {
      console.error('[bulk-print] failed to load orders', ordersRes.error)
      toast.error('Failed to load orders.')
      setSections([])
      setLoading(false)
      return
    }

    const storesById = {}
    ;(storesRes.data ?? []).forEach((store) => {
      storesById[store.id] = store
    })

    setSections(buildSections(ordersRes.data ?? [], storesById))
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData()
  }, [fetchData])

  function toggleExpanded(key) {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function requestPrintGroup(section, group) {
    setPrintConfirm({ section, group })
  }

  function confirmPendingPrint() {
    const pending = printConfirm
    setPrintConfirm(null)
    if (pending) handlePrintGroup(pending.section, pending.group)
  }

  async function handlePrintGroup(section, group) {
    setPrintingKey(group.key)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error('You must be logged in to print.')
        return
      }

      const res = await fetch(apiUrl('/api/shopee/print-awb'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ store_id: group.storeId, order_sn_list: group.orderSns }),
      })

      const contentType = res.headers.get('content-type') || ''
      const filename = `AWB-${slugify(section.storeName, 'store')}-${slugify(group.courier, 'courier')}-${group.orders.length}orders.pdf`

      let printedCount = group.orders.length

      if (res.ok && contentType.includes('application/pdf')) {
        downloadPdf(await res.blob(), filename)
      } else {
        const data = await res.json().catch(() => ({}))

        if (!res.ok || !data.success) {
          logPrintAwbFailure(`bulk print ${group.key}`, data)
          toast.error(printAwbErrorMessage(data, 'Failed to print labels.'))
          return
        }

        const files = await downloadAwbResponse(data, filename)
        if (files === 0) {
          logPrintAwbFailure(`bulk print ${group.key} (no pdf)`, data)
          toast.error('Shopee returned no PDF for this group.')
          return
        }

        printedCount = data.printed_order_sn_list?.length ?? printedCount

        if (data.skipped_orders?.length) {
          toast.info(`${data.skipped_orders.length} order(s) not ready — no tracking number yet.`)
        }

        if (data.failed?.length) {
          toast.error(`${data.failed.length} order(s) failed — ${describeFailedOrders(data.failed)}`)
        }
      }

      // Keep the card visible with its printed state, then refresh the rest.
      setPrintedKeys((prev) => new Set(prev).add(group.key))
      setPrintedSections((prev) =>
        prev.some((s) => s.groups.some((g) => g.key === group.key))
          ? prev
          : [...prev, { ...section, groups: [group] }]
      )

      toast.success(
        `Printed ${printedCount} label${printedCount === 1 ? '' : 's'} — ${group.courier}`
      )

      await fetchData()
    } catch (err) {
      console.error('[bulk-print] print failed', err)
      toast.error(describeRequestError(err, 'Failed to print labels.'))
    } finally {
      setPrintingKey(null)
    }
  }

  // Groups printed in this session no longer come back from the query, so
  // re-attach them for display. Built immutably: mutating `sections` here would
  // fold printed orders back into the pending count.
  const printedByStoreId = new Map()
  printedSections.forEach((section) => {
    section.groups.forEach((group) => {
      if (sections.some((s) => s.groups.some((g) => g.key === group.key))) return
      const entry = printedByStoreId.get(section.storeId) ?? { section, groups: [] }
      entry.groups.push(group)
      printedByStoreId.set(section.storeId, entry)
    })
  })

  const visibleSections = sections.map((section) => ({
    ...section,
    groups: [...section.groups, ...(printedByStoreId.get(section.storeId)?.groups ?? [])],
  }))

  // Stores whose every group is already printed have dropped out of `sections`.
  printedByStoreId.forEach((entry, storeId) => {
    if (!sections.some((s) => s.storeId === storeId)) {
      visibleSections.push({ ...entry.section, groups: entry.groups })
    }
  })

  const totalGroups = visibleSections.reduce((sum, s) => sum + s.groups.length, 0)
  // Counts what is still waiting to print, so it drops as groups are printed.
  const pendingOrders = sections.reduce(
    (sum, s) => sum + s.groups.reduce((n, g) => n + g.orders.length, 0),
    0
  )

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 border-b border-[#ECECEC] bg-[#FAF9F6] px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/orders')}
            aria-label="Back to orders"
            className="-ml-1 rounded-lg p-1 text-[#374151] hover:bg-[#F3F4F6]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-[#1F2937]">Bulk Print AWB</h1>
            <p className="text-xs text-[#6B7280]">
              {loading
                ? 'Loading...'
                : `${pendingOrders} order${pendingOrders === 1 ? '' : 's'} ready to print`}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3 px-4 pt-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-[#ECECEC] bg-white p-4 shadow-sm">
              <Skeleton className="h-4 w-40 bg-gray-200" />
              <Skeleton className="mt-3 h-8 w-full bg-gray-200" />
            </div>
          ))}
        </div>
      ) : totalGroups === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-24 text-center">
          <p className="text-2xl">🎉</p>
          <p className="text-sm font-medium text-[#1F2937]">All labels printed</p>
          <p className="text-xs text-[#6B7280]">Nothing is waiting for an AWB right now.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/orders')}
            className="mt-3 border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6]"
          >
            Back to Orders
          </Button>
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <div className="rounded-xl border border-[#ECECEC] bg-white px-4 py-3 shadow-sm">
              <p className="text-xs text-[#6B7280]">
                <span className="font-semibold text-[#1F2937]">{pendingOrders}</span> order
                {pendingOrders === 1 ? '' : 's'} across{' '}
                <span className="font-semibold text-[#1F2937]">{totalGroups}</span> group
                {totalGroups === 1 ? '' : 's'}
              </p>
              <p className="mt-1 text-[11px] text-gray-500">
                Shopee prints one file per logistics channel, so each group is printed separately.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-5 px-4 pt-4">
            {visibleSections.map((section) => (
              <div key={section.storeId}>
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      PLATFORM_BADGE[section.platform] ?? PLATFORM_BADGE.shopee
                    )}
                  >
                    {PLATFORM_LABELS[section.platform] ?? section.platform}
                  </span>
                  <p className="truncate text-sm font-semibold text-[#1F2937]">
                    {section.storeName}
                  </p>
                  {section.shopId && (
                    <span className="shrink-0 font-mono text-[10px] text-gray-400">
                      {section.shopId}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {section.groups.map((group) => (
                    <GroupCard
                      key={group.key}
                      section={section}
                      group={group}
                      printing={printingKey === group.key}
                      printed={printedKeys.has(group.key)}
                      expanded={expandedKeys.has(group.key)}
                      onToggle={toggleExpanded}
                      onPrint={requestPrintGroup}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <PrintAwbConfirmDialog
        open={Boolean(printConfirm)}
        count={printConfirm?.group?.orders.length ?? 1}
        onCancel={() => setPrintConfirm(null)}
        onConfirm={confirmPendingPrint}
      />
    </div>
  )
}
