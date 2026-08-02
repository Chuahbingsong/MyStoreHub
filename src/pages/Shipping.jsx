import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, Loader2, Lock, Minus, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { apiUrl } from '@/lib/apiBase'

// Shipping methods — which couriers each store offers at checkout.
//
// Every `enabled` value on this page is read live from Shopee on load; nothing
// is cached locally. After a toggle, the server re-reads that store's full
// channel list and returns it, and we render THAT — never the value the seller
// asked for. See api/shopee/logistics-channels.js.

/**
 * Shopee returns two genuinely different channels both named "SPX Express
 * (Sea Shipping)" (20077 and 20078). Anywhere two rows in the same group
 * share a name, the id is appended so they can be told apart.
 */
function disambiguate(channels) {
  const counts = new Map()
  for (const c of channels) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  return channels.map((c) => ({
    ...c,
    displayName: counts.get(c.name) > 1 ? `${c.name} · #${c.logisticsChannelId}` : c.name,
  }))
}

/** Rows where the stores don't agree — the thing worth noticing on this page. */
function findDivergent(groups, storeIds) {
  const out = []
  for (const g of groups) {
    for (const c of g.channels) {
      const values = storeIds
        .map((id) => c.states[id])
        .filter((s) => s?.present)
        .map((s) => s.enabled)
      if (values.length < 2) continue
      if (values.some((v) => v !== values[0])) {
        out.push({ group: g, channel: c })
      }
    }
  }
  return out
}

/** Folds a single store's freshly re-read tree back into the merged grid. */
function applyStoreTree(groups, storeId, tree) {
  const treeByMask = new Map(tree.map((g) => [g.maskChannelId, g]))

  return groups.map((g) => {
    const fresh = treeByMask.get(g.maskChannelId)
    if (!fresh) return g

    const freshByChannel = new Map(fresh.channels.map((c) => [c.logisticsChannelId, c]))

    return {
      ...g,
      parentStates: { ...g.parentStates, [storeId]: { enabled: fresh.parentEnabled } },
      channels: g.channels.map((c) => {
        const fc = freshByChannel.get(c.logisticsChannelId)
        if (!fc) return c
        return {
          ...c,
          states: {
            ...c.states,
            [storeId]: {
              present: true,
              enabled: fc.enabled,
              codEnabled: fc.codEnabled,
              locked: fc.locked,
              lockReason: fc.lockReason,
              parentEnabled: fresh.parentEnabled,
            },
          },
        }
      }),
    }
  })
}

function StateCell({ state, onClick, label }) {
  if (!state?.present) {
    return (
      <div className="flex h-11 items-center justify-center" title="Not offered for this store">
        <Minus className="h-4 w-4 text-[#D1D5DB]" />
      </div>
    )
  }

  if (state.locked) {
    return (
      <div
        className="flex h-11 items-center justify-center"
        title={
          state.lockReason === 'compulsory'
            ? 'Shopee requires this courier — it cannot be turned off'
            : 'Shopee forces this courier on — it cannot be changed'
        }
      >
        <Lock className={cn('h-4 w-4', state.enabled ? 'text-emerald-600/60' : 'text-[#9CA3AF]')} />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex h-11 w-full items-center justify-center transition-colors',
        'hover:bg-[#F3F4F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400'
      )}
    >
      <span
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border',
          state.enabled
            ? 'border-emerald-600 bg-emerald-600 text-white'
            : 'border-[#D1D5DB] bg-white text-[#D1D5DB]'
        )}
      >
        {state.enabled ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
      </span>
    </button>
  )
}

export default function Shipping() {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [stores, setStores] = useState([])
  const [groups, setGroups] = useState([])
  const [fetchedAt, setFetchedAt] = useState(null)

  const [pending, setPending] = useState(null) // the toggle awaiting confirmation
  const [submitting, setSubmitting] = useState(false)
  const [lastResult, setLastResult] = useState(null)

  const load = useCallback(async (showSpinner = true, isCancelled = () => false) => {
    if (showSpinner) setLoading(true)
    setLoadError(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        setLoadError(t('shipping.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/logistics-channels'), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (isCancelled()) return

      if (!res.ok || !data.success) {
        setLoadError(data.error || t('shipping.loadError'))
        return
      }

      setStores(data.stores ?? [])
      setGroups(data.groups ?? [])
      setFetchedAt(data.fetchedAt ?? null)
    } catch (err) {
      console.error('[shipping] load failed', err)
      if (!isCancelled()) setLoadError(t('shipping.loadError'))
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      await load(true, () => cancelled)
    })()

    return () => {
      cancelled = true
    }
  }, [load])

  const okStores = useMemo(() => stores.filter((s) => s.ok), [stores])
  const failedStores = useMemo(() => stores.filter((s) => !s.ok), [stores])
  const storeIds = useMemo(() => okStores.map((s) => s.id), [okStores])
  const storeName = useCallback(
    (id) => stores.find((s) => s.id === id)?.shopName ?? 'this store',
    [stores]
  )

  const divergent = useMemo(() => findDivergent(groups, storeIds), [groups, storeIds])

  const confirmToggle = async () => {
    if (!pending) return
    setSubmitting(true)
    setLastResult(null)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        toast.error(t('shipping.loginRequired'))
        return
      }

      const res = await fetch(apiUrl('/api/shopee/logistics-channels'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          store_id: pending.storeId,
          logistics_channel_id: pending.channel.logisticsChannelId,
          enabled: pending.next,
        }),
      })
      const data = await res.json()

      // Whatever happened, the server re-read the truth — render that.
      if (data.tree) {
        setGroups((prev) => applyStoreTree(prev, pending.storeId, data.tree))
      }

      if (!res.ok || !data.success) {
        setLastResult({
          kind: data.unverified ? 'unverified' : 'error',
          storeName: storeName(pending.storeId),
          channelName: pending.channel.displayName,
          message: data.error || t('shipping.toggleError'),
          collateral: data.collateral ?? [],
        })
        toast.error(data.error || t('shipping.toggleError'))
        return
      }

      const collateral = data.collateral ?? []

      if (!data.confirmed) {
        // Shopee took the call and did nothing. The whole point of the
        // read-back is that this can no longer look like success.
        setLastResult({
          kind: 'unapplied',
          storeName: storeName(pending.storeId),
          channelName: pending.channel.displayName,
          requested: pending.next,
          actual: data.channel?.enabled,
          collateral,
        })
        toast.error(t('shipping.notApplied'))
        return
      }

      setLastResult({
        kind: collateral.length > 0 ? 'collateral' : 'ok',
        storeName: storeName(pending.storeId),
        channelName: pending.channel.displayName,
        enabled: data.channel?.enabled,
        noop: data.noop === true,
        collateral,
      })

      if (collateral.length > 0) {
        toast.warning(t('shipping.collateralToast', { count: collateral.length }))
      } else {
        toast.success(
          pending.next ? t('shipping.enabledToast') : t('shipping.disabledToast')
        )
      }
    } catch (err) {
      console.error('[shipping] toggle failed', err)
      setLastResult({
        kind: 'unverified',
        storeName: storeName(pending.storeId),
        channelName: pending.channel.displayName,
        message: t('shipping.toggleError'),
        collateral: [],
      })
      toast.error(t('shipping.toggleError'))
    } finally {
      setSubmitting(false)
      setPending(null)
    }
  }

  const gridCols = {
    gridTemplateColumns: `minmax(9.5rem,1fr) repeat(${okStores.length}, 5.5rem)`,
  }

  return (
    <div className="pb-24">
      <header className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F2937]">{t('shipping.title')}</h1>
          <p className="text-[11px] text-[#6B7280]">
            {fetchedAt
              ? t('shipping.liveAt', { time: new Date(fetchedAt).toLocaleTimeString() })
              : t('shipping.subtitle')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load(false)}
          disabled={loading}
          className="gap-1.5"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('shipping.refresh')}
        </Button>
      </header>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#6B7280]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('shipping.loading')}
        </div>
      ) : loadError ? (
        <div className="mx-4 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      ) : okStores.length === 0 ? (
        <div className="px-4 py-16 text-center text-sm text-[#6B7280]">{t('shipping.noStores')}</div>
      ) : (
        <>
          {failedStores.length > 0 && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              {t('shipping.storesFailed', {
                names: failedStores.map((s) => s.shopName).join(', '),
              })}
            </div>
          )}

          {/* The discrepancy callout. Shipping settings drift store by store
              and nobody notices, because you only ever see one Seller Centre
              at a time. This is the reason the page is a grid. */}
          {divergent.length > 0 && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-amber-900">
                    {t('shipping.divergent.title', { count: divergent.length })}
                  </p>
                  <p className="mt-0.5 text-[11px] text-amber-800">
                    {t('shipping.divergent.description')}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {divergent.map(({ channel }) => {
                      const on = storeIds.filter((id) => channel.states[id]?.enabled)
                      const off = storeIds.filter(
                        (id) => channel.states[id]?.present && !channel.states[id].enabled
                      )
                      return (
                        <li key={channel.logisticsChannelId} className="text-[11px] text-amber-900">
                          <span className="font-medium">{channel.name}</span>
                          <span className="text-amber-700">
                            {' — '}
                            {t('shipping.divergent.onOff', {
                              on: on.map(storeName).join(', ') || '—',
                              off: off.map(storeName).join(', ') || '—',
                            })}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {lastResult && (
            <ResultBanner result={lastResult} onDismiss={() => setLastResult(null)} t={t} />
          )}

          <div className="mt-3 overflow-x-auto">
            <div className="min-w-max">
              <div
                className="sticky top-0 z-10 grid items-end border-b border-[#E8E6E1] bg-white"
                style={gridCols}
              >
                <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
                  {t('shipping.courier')}
                </div>
                {okStores.map((s) => (
                  <div
                    key={s.id}
                    className="px-1 py-2 text-center text-[11px] font-semibold leading-tight text-[#1F2937]"
                  >
                    {s.shopName}
                  </div>
                ))}
              </div>

              {groups.map((group) => {
                const channels = disambiguate(group.channels)
                return (
                  <div key={group.maskChannelId}>
                    <div className="grid border-b border-[#F0EEE9] bg-[#FAFAF9]" style={gridCols}>
                      <div className="flex items-center gap-1.5 px-4 py-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
                          {group.name ?? t('shipping.standalone')}
                        </span>
                        {group.maskChannelId !== 0 && (
                          <span className="inline-flex" title={t('shipping.parentLocked')}>
                            <Lock className="h-3 w-3 text-[#9CA3AF]" />
                          </span>
                        )}
                      </div>
                      {group.maskChannelId !== 0
                        ? okStores.map((s) => {
                            const on = group.parentStates?.[s.id]?.enabled
                            return (
                              <div
                                key={s.id}
                                className={cn(
                                  'flex items-center justify-center py-2 text-[10px] font-medium uppercase',
                                  on ? 'text-emerald-700' : 'text-[#9CA3AF]'
                                )}
                              >
                                {on == null ? '—' : on ? t('shipping.on') : t('shipping.off')}
                              </div>
                            )
                          })
                        : okStores.map((s) => <div key={s.id} />)}
                    </div>

                    {channels.length === 0 && group.maskChannelId !== 0 && (
                      <div className="grid border-b border-[#F5F4F1]" style={gridCols}>
                        <div className="px-4 py-2 text-[11px] italic text-[#9CA3AF]">
                          {t('shipping.sharedChildren')}
                        </div>
                        {okStores.map((s) => (
                          <div key={s.id} />
                        ))}
                      </div>
                    )}

                    {channels.map((channel) => {
                      const isDivergent = divergent.some(
                        (d) => d.channel.logisticsChannelId === channel.logisticsChannelId
                      )
                      return (
                        <div
                          key={channel.logisticsChannelId}
                          className={cn(
                            'grid border-b border-[#F5F4F1]',
                            isDivergent && 'bg-amber-50/60'
                          )}
                          style={gridCols}
                        >
                          <div className="flex min-w-0 flex-col justify-center px-4 py-1.5">
                            <span className="truncate text-[13px] text-[#1F2937]">
                              {channel.displayName}
                            </span>
                            {channel.alsoUnderMaskIds?.length > 0 && (
                              <span className="text-[10px] text-[#9CA3AF]">
                                {t('shipping.alsoUnder')}
                              </span>
                            )}
                          </div>
                          {okStores.map((s) => (
                            <StateCell
                              key={s.id}
                              state={channel.states[s.id]}
                              label={t('shipping.toggleAria', {
                                channel: channel.displayName,
                                store: s.shopName,
                              })}
                              onClick={() =>
                                setPending({
                                  storeId: s.id,
                                  storeName: s.shopName,
                                  group,
                                  channel,
                                  current: channel.states[s.id]?.enabled === true,
                                  next: !(channel.states[s.id]?.enabled === true),
                                  state: channel.states[s.id],
                                })
                              }
                            />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>

          <p className="px-4 py-4 text-[11px] leading-relaxed text-[#9CA3AF]">
            {t('shipping.footnote')}
          </p>
        </>
      )}

      <ConfirmDialog
        pending={pending}
        submitting={submitting}
        onCancel={() => !submitting && setPending(null)}
        onConfirm={confirmToggle}
        t={t}
      />
    </div>
  )
}

function ResultBanner({ result, onDismiss, t }) {
  const tone =
    result.kind === 'ok'
      ? { box: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-800' }
      : result.kind === 'collateral'
        ? { box: 'border-amber-300 bg-amber-50', text: 'text-amber-900' }
        : { box: 'border-red-200 bg-red-50', text: 'text-red-800' }

  return (
    <div className={cn('mx-4 mt-3 rounded-lg border px-3 py-3', tone.box)}>
      <div className="flex items-start gap-2">
        {result.kind === 'ok' ? (
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', tone.text)} />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13px] font-semibold', tone.text)}>
            {result.kind === 'ok' &&
              t('shipping.result.ok', {
                channel: result.channelName,
                store: result.storeName,
                state: result.enabled ? t('shipping.on') : t('shipping.off'),
              })}
            {result.kind === 'collateral' &&
              t('shipping.result.collateral', {
                channel: result.channelName,
                store: result.storeName,
              })}
            {result.kind === 'unapplied' &&
              t('shipping.result.unapplied', {
                channel: result.channelName,
                store: result.storeName,
              })}
            {result.kind === 'error' &&
              t('shipping.result.error', { channel: result.channelName, store: result.storeName })}
            {result.kind === 'unverified' && t('shipping.result.unverified')}
          </p>

          {result.message && (
            <p className={cn('mt-0.5 text-[11px]', tone.text)}>{result.message}</p>
          )}

          {result.kind === 'unapplied' && (
            <p className="mt-0.5 text-[11px] text-red-700">
              {t('shipping.result.unappliedHint', {
                actual: result.actual ? t('shipping.on') : t('shipping.off'),
              })}
            </p>
          )}

          {result.collateral?.length > 0 && (
            <>
              <p className={cn('mt-2 text-[11px] font-medium', tone.text)}>
                {t('shipping.result.alsoChanged')}
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.collateral.map((c) => (
                  <li key={c.logistics_channel_id} className={cn('text-[11px]', tone.text)}>
                    {c.logistics_channel_name}:{' '}
                    {c.before ? t('shipping.on') : t('shipping.off')} →{' '}
                    <span className="font-semibold">
                      {c.after ? t('shipping.on') : t('shipping.off')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cn('shrink-0 text-[11px] underline', tone.text)}
        >
          {t('shipping.dismiss')}
        </button>
      </div>
    </div>
  )
}

function ConfirmDialog({ pending, submitting, onCancel, onConfirm, t }) {
  const open = Boolean(pending)
  const disabling = pending ? !pending.next : false
  const parentOff = pending ? pending.state?.parentEnabled === false : false

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="border border-[#E8E6E1] bg-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base text-[#1F2937]">
            {pending
              ? disabling
                ? t('shipping.confirm.titleDisable', {
                    channel: pending.channel.displayName,
                    store: pending.storeName,
                  })
                : t('shipping.confirm.titleEnable', {
                    channel: pending.channel.displayName,
                    store: pending.storeName,
                  })
              : ''}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[#6B7280]">
            {disabling ? t('shipping.confirm.disableBody') : t('shipping.confirm.enableBody')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {disabling && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {t('shipping.confirm.liveWarning')}
            </div>
          )}

          {pending?.channel?.hasRelationRules && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              {t('shipping.confirm.relationWarning')}
            </div>
          )}

          {!disabling && parentOff && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              {t('shipping.confirm.parentOffWarning', { group: pending?.group?.name ?? '' })}
            </div>
          )}

          <p className="text-[11px] text-[#9CA3AF]">{t('shipping.confirm.verifyNote')}</p>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
            {t('shipping.confirm.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={submitting}
            className={cn(
              'gap-1.5 text-white',
              disabling ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            )}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {submitting
              ? t('shipping.confirm.applying')
              : disabling
                ? t('shipping.confirm.confirmDisable')
                : t('shipping.confirm.confirmEnable')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
