import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Loader2, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import PrintAwbConfirmDialog from '@/components/PrintAwbConfirmDialog'
import PrintAwbMarkPrintedDialog from '@/components/PrintAwbMarkPrintedDialog'
import { supabase } from '@/lib/supabase'
import { selectAllPaged } from '@/lib/supabaseSelect'
import { cn } from '@/lib/utils'
import { apiUrl, describeRequestError } from '@/lib/apiBase'
import { useTranslation } from '@/lib/i18n/I18nContext'
import {
  base64ToPdfBlob,
  deliverPdf,
  downloadAwbResponse,
  describeFailedOrders,
  isNativePlatform,
  logPrintAwbFailure,
  printAwbErrorMessage,
  slugify,
} from '@/lib/awb'
import {
  confirmPendingAwbPrint,
  dismissPendingAwbPrint,
  finalizeAwbDelivery,
  usePendingAwbPrint,
} from '@/lib/awbPrintPrompt'

// Raw Shopee statuses for orders still awaiting handover, i.e. the ones that
// still need a label. SHIPPED/COMPLETED/CANCELLED are already out the door.
const PRINTABLE_STATUSES = ['READY_TO_SHIP', 'PROCESSED']

// The map key for orders with no courier_name. Deliberately the empty string
// and NOT a display label: this value is a Map key, half of groupKey(), and a
// comparison target (`isUnknownCourier`). It used to be the literal
// 'Unknown courier', which meant translating that label would have silently
// changed every group key — and, via slugify(), the printed PDF's filename too.
// The label the seller reads is resolved separately, at render, through t().
const NO_COURIER = ''

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
    const courier = order.courier_name || NO_COURIER

    if (!byStore.has(storeId)) byStore.set(storeId, new Map())
    const byCourier = byStore.get(storeId)

    if (!byCourier.has(courier)) byCourier.set(courier, [])
    byCourier.get(courier).push(order)
  })

  // Stays a pure function with no access to t(): everything it returns is
  // either Shopee DATA (courier name, shop name) or null, and the placeholder
  // labels for the nulls are resolved at render. That also keeps the printed
  // PDF filenames — built from storeName/courier via slugify() — identical in
  // both locales, which is what an operator filing them expects.
  return [...byStore.entries()].map(([storeId, byCourier]) => {
    const store = storesById[storeId]
    return {
      storeId,
      storeName: store?.shop_name || null,
      shopId: store?.shop_id ?? null,
      platform: store?.platform ?? 'shopee',
      groups: [...byCourier.entries()].map(([courier, groupOrders]) => ({
        key: groupKey(storeId, courier),
        storeId,
        courier: courier || null,
        isUnknownCourier: courier === NO_COURIER,
        orders: groupOrders,
        orderSns: groupOrders.map((o) => o.platform_order_id),
      })),
    }
  })
}

function GroupCard({ section, group, printing, printed, expanded, onToggle, onPrint }) {
  const { t } = useTranslation()
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
            <p className="truncate text-sm font-medium text-[#1F2937]">
              {group.courier ?? t('bulkPrint.unknownCourier')}
            </p>
            {group.isUnknownCourier && (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            )}
          </div>

          <button
            onClick={() => onToggle(group.key)}
            className="mt-0.5 flex items-center gap-1 text-xs text-[#6B7280]"
          >
            {t('bulkPrint.orderCount', { count })}
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
            />
          </button>

          {group.isUnknownCourier && (
            <p className="mt-1 text-[11px] text-amber-600">{t('bulkPrint.noCourierWarning')}</p>
          )}
        </div>

        {printed ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-700">
            <Check className="h-3.5 w-3.5" /> {t('bulkPrint.printed')}
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() => onPrint(section, group)}
            disabled={printing}
            className="shrink-0 bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            {printing ? t('bulkPrint.printing') : t('bulkPrint.print')}
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
  const { t } = useTranslation()
  const [sections, setSections] = useState([])
  const [loading, setLoading] = useState(true)
  const [printingKey, setPrintingKey] = useState(null)
  const [printingAll, setPrintingAll] = useState(false)
  const [printedKeys, setPrintedKeys] = useState(new Set())
  const [expandedKeys, setExpandedKeys] = useState(new Set())
  // Groups printed in this session are kept on screen with a ✓ state even
  // though awb_printed now excludes them from the query.
  const [printedSections, setPrintedSections] = useState([])
  const [printConfirm, setPrintConfirm] = useState(null) // { section, group } | null
  const pendingAwbPrint = usePendingAwbPrint()

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
      toast.error(t('bulkPrint.loadError'))
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
    // `t` is a dependency because the load-failure toast above reads it. It
    // only changes identity when the locale does, so the extra refetch is one
    // per language switch.
  }, [t])

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

  // Keeps a just-printed group's card visible with its ✓ state even though
  // awb_printed now excludes it from fetchData()'s query.
  function markGroupPrintedInUI(section, group, printedCount) {
    setPrintedKeys((prev) => new Set(prev).add(group.key))
    setPrintedSections((prev) =>
      prev.some((s) => s.groups.some((g) => g.key === group.key))
        ? prev
        : [...prev, { ...section, groups: [group] }]
    )
    toast.success(
      t('bulkPrint.printedToast', {
        count: printedCount,
        courier: group.courier ?? t('bulkPrint.unknownCourier'),
      })
    )
  }

  async function handleConfirmPendingAwbPrint() {
    const meta = pendingAwbPrint?.meta
    await confirmPendingAwbPrint()
    // The merged run has no single section/group to tick off — its cards just
    // disappear on refetch once the orders are marked printed.
    if (meta && !meta.mergedAll) markGroupPrintedInUI(meta.section, meta.group, meta.printedCount)
    await fetchData()
  }

  /**
   * One merged PDF for the whole Shopee backlog, across every store and
   * courier. Distinct from the per-group buttons below: those ask Shopee for
   * one document per logistics channel, which is what Shopee itself supports.
   * This one stitches the labels together server-side instead, so the operator
   * gets a single file to send to the printer.
   */
  async function handlePrintAllMerged() {
    setPrintingAll(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('bulkPrint.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/print-awb'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ print_all_unprinted: true }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || !data.success) {
        logPrintAwbFailure('print all unprinted', data)
        // printAwbErrorMessage returns Shopee's OWN per-order failure text when
        // it has any — marketplace data, shown verbatim. Only the fallback
        // here is ours to translate.
        toast.error(printAwbErrorMessage(data, t('bulkPrint.printError')))
        return
      }

      if (!data.pdf_base64) {
        toast.info(data.message || t('bulkPrint.nothingToPrint'))
        await fetchData()
        return
      }

      const printedCount = data.printed_order_sn_list?.length ?? 0
      const filename = `AWB-all-${printedCount}orders.pdf`

      try {
        await deliverPdf(base64ToPdfBlob(data.pdf_base64), filename)
      } catch (err) {
        console.error('[bulk-print] merged PDF did not reach the device', err)
        toast.error(t('bulkPrint.deliveryError'))
        return
      }

      await finalizeAwbDelivery({
        accessToken: session.access_token,
        groups: (data.printed_by_store ?? []).map((entry) => ({
          storeId: entry.store_id,
          orderSnList: entry.order_sn_list,
        })),
        meta: { mergedAll: true, printedCount },
      })

      toast.success(t('bulkPrint.mergedToast', { count: printedCount }))

      if (data.remaining_unprinted > 0) {
        toast.info(t('bulkPrint.remainingToast', { count: data.remaining_unprinted }))
      }

      if (data.skipped_orders?.length) {
        // `reason` is Shopee's own explanation, assembled by describeFailedOrders
        // — passed through untranslated.
        toast.info(
          t('bulkPrint.skippedToast', {
            count: data.skipped_orders.length,
            reason: describeFailedOrders(data.skipped_orders),
          })
        )
      }

      await fetchData()
    } catch (err) {
      console.error('[bulk-print] print all request failed', err)
      toast.error(describeRequestError(t, err, t('bulkPrint.printError')))
    } finally {
      setPrintingAll(false)
    }
  }

  async function handlePrintGroup(section, group) {
    setPrintingKey(group.key)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        toast.error(t('bulkPrint.loginRequired'))
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
      // slugify()'s fallbacks ('store', 'courier') now do the work the
      // 'Unknown store'/'Unknown courier' labels used to, which keeps the
      // filename byte-identical in both locales.
      const filename = `AWB-${slugify(section.storeName, 'store')}-${slugify(group.courier, 'courier')}-${group.orders.length}orders.pdf`

      let printedCount = group.orders.length
      let deliveredOrderSns = group.orderSns

      if (res.ok && contentType.includes('application/pdf')) {
        try {
          await deliverPdf(await res.blob(), filename)
        } catch (err) {
          console.error(`[bulk-print] PDF did not reach the device for ${group.key}`, err)
          toast.error(t('bulkPrint.deliveryError'))
          return
        }
      } else {
        const data = await res.json().catch(() => ({}))

        if (!res.ok || !data.success) {
          logPrintAwbFailure(`bulk print ${group.key}`, data)
          toast.error(printAwbErrorMessage(data, t('bulkPrint.printError')))
          return
        }

        const result = await downloadAwbResponse(data, filename)
        if (result.fileCount === 0) {
          logPrintAwbFailure(`bulk print ${group.key} (no pdf)`, data)
          toast.error(t('bulkPrint.deliveryError'))
          return
        }

        deliveredOrderSns = result.deliveredOrderSns
        printedCount = deliveredOrderSns.length

        if (data.skipped_orders?.length) {
          toast.info(t('bulkPrint.notReadyToast', { count: data.skipped_orders.length }))
        }

        if (data.failed?.length) {
          toast.error(
            t('bulkPrint.failedToast', {
              count: data.failed.length,
              reason: describeFailedOrders(data.failed),
            })
          )
        }
      }

      // Native: deliverPdf only launched the "Open with" chooser — marking
      // printed (and the UI below that depends on it) waits for the user to
      // confirm via the resume prompt (see awbPrintPrompt.js). Browser/PWA:
      // unchanged, mark immediately since there's no resume signal to hang a
      // prompt off of.
      await finalizeAwbDelivery({
        storeId: group.storeId,
        accessToken: session.access_token,
        orderSnList: deliveredOrderSns,
        meta: { section, group, printedCount },
      })

      if (!isNativePlatform()) {
        markGroupPrintedInUI(section, group, printedCount)
        await fetchData()
      }
    } catch (err) {
      console.error('[bulk-print] print failed', err)
      toast.error(describeRequestError(t, err, t('bulkPrint.printError')))
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

  // What the merged print would actually cover. Narrower than pendingOrders:
  // Shopee only, and only PROCESSED — a READY_TO_SHIP order cannot have a
  // shipping document created yet, so it is not printable in any form.
  const mergeableOrders = sections
    .filter((s) => s.platform === 'shopee')
    .flatMap((s) => s.groups)
    .flatMap((g) => g.orders)
    .filter((o) => o.order_status === 'PROCESSED')
  const mergeableCount = mergeableOrders.length

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 border-b border-[#ECECEC] bg-[#FAF9F6] px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/orders')}
            aria-label={t('bulkPrint.backToOrders')}
            className="-ml-1 rounded-lg p-1 text-[#374151] hover:bg-[#F3F4F6]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-[#1F2937]">{t('bulkPrint.title')}</h1>
            <p className="text-xs text-[#6B7280]">
              {loading
                ? t('bulkPrint.loading')
                : t('bulkPrint.readyToPrint', { count: pendingOrders })}
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
          <p className="text-sm font-medium text-[#1F2937]">{t('bulkPrint.allPrinted')}</p>
          <p className="text-xs text-[#6B7280]">{t('bulkPrint.allPrintedHint')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/orders')}
            className="mt-3 border-[#E5E7EB] text-[#374151] hover:bg-[#F3F4F6]"
          >
            {t('bulkPrint.backToOrdersButton')}
          </Button>
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <div className="rounded-xl border border-[#ECECEC] bg-white px-4 py-3 shadow-sm">
              {/* Two counts in one sentence, so the emphasis is applied by
                  splitting the translated string around its {{orders}} and
                  {{groups}} placeholders rather than by concatenating
                  fragments — word order differs between en and zh-CN. */}
              <p className="text-xs text-[#6B7280]">
                {t('bulkPrint.summary', {
                  orders: pendingOrders,
                  groups: totalGroups,
                })}
              </p>
              <p className="mt-1 text-[11px] text-gray-500">{t('bulkPrint.perChannelNote')}</p>

              <div className="mt-3 border-t border-[#F3F4F6] pt-3">
                <Button
                  size="sm"
                  onClick={handlePrintAllMerged}
                  disabled={printingAll || printingKey !== null || mergeableCount === 0}
                  className="h-9 w-full rounded-lg bg-[#2563EB] text-[13px] font-medium text-white hover:bg-[#2563EB]/90"
                >
                  {printingAll ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Printer className="h-4 w-4" />
                  )}
                  {printingAll
                    ? t('bulkPrint.preparingMerged')
                    : mergeableCount > 0
                      ? t('bulkPrint.printMergedCount', { count: mergeableCount })
                      : t('bulkPrint.printMerged')}
                </Button>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  {mergeableCount === 0
                    ? t('bulkPrint.mergeUnavailable')
                    : t('bulkPrint.mergeAvailable')}
                </p>
              </div>
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
                    {section.storeName ??
                      (section.shopId
                        ? t('bulkPrint.shopFallback', { id: section.shopId })
                        : t('bulkPrint.unknownStore'))}
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

      <PrintAwbMarkPrintedDialog
        open={Boolean(pendingAwbPrint)}
        count={pendingAwbPrint?.orderSnList?.length ?? 1}
        onCancel={dismissPendingAwbPrint}
        onConfirm={handleConfirmPendingAwbPrint}
      />
    </div>
  )
}
