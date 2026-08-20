import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'
import { ArrowLeft, Flashlight, FlashlightOff, Loader2, Package, ScanLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n/I18nContext'
import { statusKeyFor } from '@/lib/orderStatus'

const SCANNER_ELEMENT_ID = 'scan-reader'

// Which help text a denied camera gets. In the APK the WebView has no browser
// UI at all — a denied CAMERA permission is an Android app permission, revoked
// and restored from the system Settings app — so the web wording ("this site",
// "browser settings") is not just wrong there, it points nowhere. Read once at
// module scope: the platform can't change mid-session. Only the KEY is chosen
// here; the text itself is resolved through t() at render, because module
// scope has no locale.
const CAMERA_DENIED_HELP_KEY = Capacitor.isNativePlatform()
  ? 'scan.cameraDenied.native'
  : 'scan.cameraDenied.web'

// Shared pill style — matches Orders'/Dashboard's BADGE_CLS so all three
// pages read as one system.
const BADGE_CLS = 'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none'

// Keyed by STABLE STATUS KEY, never by a display label.
//
// The previous map here was keyed by English labels ('To Pack', 'Invoice
// Pending', ...) but the only thing ever looked up in it was
// `result.order_status` — the platform's RAW enum (READY_TO_SHIP, PROCESSED,
// UNPAID; shopeeSync.js / lazadaSync.js / tiktokSync.js each write their own
// platform's value straight through). So every lookup missed, every badge fell
// back to grey, and the raw enum was rendered to the seller as the status text.
//
// statusKeyFor() from lib/orderStatus.js now does the raw -> key mapping that
// Orders and Dashboard already used, so this page finally shows real status
// wording. Colours match Orders' STATUS_BADGE so a parcel reads the same on
// both screens.
const STATUS_BADGE = {
  unpaid: 'bg-gray-200 text-gray-600',
  invoicePending: 'bg-orange-500/15 text-orange-600',
  toPack: 'bg-yellow-600/15 text-yellow-700',
  packed: 'bg-yellow-600/15 text-yellow-700',
  retryShipment: 'bg-orange-600/15 text-orange-700',
  shipped: 'bg-green-500/15 text-green-600',
  toConfirmReceipt: 'bg-green-500/15 text-green-600',
  completed: 'bg-teal-500/15 text-teal-600',
  cancelRequested: 'bg-amber-500/15 text-amber-700',
  returnRequested: 'bg-amber-500/15 text-amber-700',
  returned: 'bg-amber-600/15 text-amber-800',
  cancelled: 'bg-red-500/15 text-red-600',
}

const DEFAULT_STATUS_BADGE = 'bg-gray-200 text-gray-600'

// A tracking_number scanned off an AWB can only ever belong to one store's
// order, but .limit(1) (rather than .maybeSingle()) is used deliberately: a
// second match would otherwise throw instead of just taking the first row.
async function findOrderBy(column, value) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, stores(shop_name, platform), order_items(*)')
    .eq(column, value)
    .limit(1)

  if (error) throw error
  return data?.[0] ?? null
}

export default function Scan() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [cameraState, setCameraState] = useState('starting') // starting | running | denied
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [manualValue, setManualValue] = useState('')
  const [looking, setLooking] = useState(false)
  const [result, setResult] = useState(null)
  const [notFoundText, setNotFoundText] = useState(null)
  const [previewImage, setPreviewImage] = useState(null)

  const scannerRef = useRef(null)
  const handledRef = useRef(false)
  // Guards state updates from startCamera()'s async start() call resolving
  // after the component has already unmounted (e.g. Back pressed while the
  // camera permission prompt/init is still in flight).
  const isMountedRef = useRef(true)

  // Scan is only ever entered via navigate('/scan') from Orders or
  // Dashboard, so there's always a prior entry — navigate(-1) returns to
  // whichever of those it actually came from.
  function handleBack() {
    navigate(-1)
  }

  async function lookupOrder(rawText) {
    const trimmed = rawText.trim()
    if (!trimmed) return

    setLooking(true)
    setResult(null)
    setNotFoundText(null)
    try {
      // Different AWB barcodes/QRs encode different Shopee identifiers —
      // tracking_number is most common, but package_number and the order_sn
      // (platform_order_id) both show up too, and tracking_number is only
      // backfilled gradually for orders printed outside this app. Trying all
      // three means a parcel scans as soon as ANY one of them is populated.
      let order = await findOrderBy('tracking_number', trimmed)
      if (!order) order = await findOrderBy('package_number', trimmed)
      if (!order) order = await findOrderBy('platform_order_id', trimmed)

      if (!order) {
        setNotFoundText(trimmed)
      } else {
        setResult(order)
      }
    } catch (err) {
      console.error('[scan] lookup failed', err)
      toast.error(t('scan.lookupError'))
    } finally {
      setLooking(false)
    }
  }

  function checkTorchSupport() {
    try {
      const caps = scannerRef.current?.getRunningTrackCapabilities?.()
      setTorchSupported(!!caps?.torch)
    } catch {
      setTorchSupported(false)
    }
  }

  // Stops the stream only — used by the in-app "scan again" flow and the
  // successful-decode path, both of which reuse the same Html5Qrcode
  // instance and DOM node for a subsequent start(), so the container must be
  // left intact (not cleared).
  async function stopCamera() {
    const inst = scannerRef.current
    if (!inst || !inst.isScanning) return
    try {
      await inst.stop()
    } catch (err) {
      console.error('[scan] failed to stop camera', err)
    }
  }

  // Full teardown for a departing Html5Qrcode instance: stop() the stream
  // (async — must resolve before clear() runs, since clearElement() throws
  // if a scan is still ongoing) then clear() the DOM. Both calls are wrapped
  // individually so a throw from either never escapes — see the effect
  // cleanup below for why that matters. Only ever used when the instance is
  // being discarded (unmount, or start() resolving after unmount) — never
  // for the in-app restart flow above, which needs the container intact.
  //
  // Deliberately does NOT gate the stop() call on inst.isScanning: that
  // property is set inside html5-qrcode's onRenderSurfaceReady callback,
  // which fires before its internal state manager commits the SCANNING
  // state (see stop()/clearElement() in html5-qrcode's source, both of
  // which check the state manager, not this property). Unmounting inside
  // that gap — property still false, state manager already SCANNING — made
  // this code skip stop() and go straight to a clear() that then threw
  // "Cannot clear while scan is ongoing". Always attempting stop() and
  // letting its own "nothing to stop" throw be swallowed sidesteps the two
  // signals ever disagreeing.
  async function teardownOnUnmount(inst) {
    if (!inst) return
    try {
      await inst.stop()
    } catch (err) {
      // Expected whenever there was nothing running yet to stop.
      console.error('[scan] failed to stop camera on unmount', err)
    }
    try {
      // Html5Qrcode.clear() (the plain-API class used here) returns void,
      // not a Promise — unlike Html5QrcodeScanner.clear(). Calling it
      // synchronously inside try/catch, never .catch()-chained.
      inst.clear()
    } catch (err) {
      console.error('[scan] failed to clear camera on unmount', err)
    }
  }

  async function startCamera() {
    const inst = scannerRef.current
    if (!inst) return

    setCameraState('starting')
    handledRef.current = false
    setTorchOn(false)

    try {
      await inst.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        (decodedText) => {
          if (handledRef.current) return
          handledRef.current = true
          stopCamera().then(() => lookupOrder(decodedText))
        },
        () => {
          // Per-frame "no code found yet" callback — expected on every frame
          // without a code in view, not an actual error.
        }
      )

      // The component may have unmounted (Back pressed) while start() was
      // still resolving — the effect cleanup below only tears down the
      // instance it knew about at unmount time, which for a still-starting
      // camera means isScanning was false and there was nothing to stop yet.
      // Without this check the camera would keep running (and stay running)
      // after navigating away, and dashboard/Orders' route would blank
      // instead of showing the previous page's UI. Not the same bug as the
      // clear()-on-void crash below, but the same "leftover live camera"
      // failure mode, so it's guarded here too.
      if (!isMountedRef.current || scannerRef.current !== inst) {
        await teardownOnUnmount(inst)
        return
      }

      setCameraState('running')
      checkTorchSupport()
    } catch (err) {
      if (!isMountedRef.current) return
      console.error('[scan] camera start failed', err)
      setCameraState('denied')
    }
  }

  useEffect(() => {
    isMountedRef.current = true
    const inst = new Html5Qrcode(SCANNER_ELEMENT_ID)
    scannerRef.current = inst
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startCamera()

    return () => {
      isMountedRef.current = false
      handledRef.current = true
      const cleanupInst = scannerRef.current
      scannerRef.current = null
      // Fire-and-forget: React can't await an effect cleanup, but wrapping
      // the whole sequence in one async function means every throw --
      // including the synchronous one clear() used to produce -- is caught
      // inside teardownOnUnmount() instead of escaping the cleanup call. An
      // escaped synchronous throw here previously aborted React's commit
      // with no ErrorBoundary anywhere in the app to catch it, blanking the
      // page.
      teardownOnUnmount(cleanupInst)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleTorch() {
    const inst = scannerRef.current
    if (!inst) return
    const next = !torchOn
    try {
      await inst.applyVideoConstraints({ advanced: [{ torch: next }] })
      setTorchOn(next)
    } catch (err) {
      console.error('[scan] torch toggle failed', err)
      toast.error(t('scan.torchUnsupported'))
    }
  }

  async function handleScanAgain() {
    setResult(null)
    setNotFoundText(null)
    setManualValue('')
    // The camera keeps running during a manual-entry lookup (only a decoded
    // scan stops it), so it must be stopped before restarting or
    // Html5Qrcode.start() throws "scanner is already running".
    await stopCamera()
    startCamera()
  }

  function handleManualSubmit(e) {
    e.preventDefault()
    lookupOrder(manualValue)
  }

  // stores.platform is the row's own lowercase slug; order_status is whatever
  // that platform's sync wrote.
  const resultStatusKey = result
    ? statusKeyFor(result.stores?.platform ?? result.platform, result.order_status)
    : null
  const showResult = result !== null
  const showNotFound = notFoundText !== null
  const idle = !showResult && !showNotFound

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 bg-[#FAF9F6] px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={handleBack}
            aria-label={t('scan.back')}
            className="-ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#374151] hover:bg-[#F3F4F6]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-[#1F2937]">
              <ScanLine className="h-5 w-5 text-[#2563EB]" />
              {t('scan.title')}
            </h1>
            <p className="mt-0.5 text-xs text-[#6B7280]">{t('scan.subtitle')}</p>
          </div>
        </div>
      </header>

      <section className="px-4 py-3">
        {idle && (
          <>
            {cameraState !== 'denied' && (
              <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl bg-black shadow-card">
                <div id={SCANNER_ELEMENT_ID} className="w-full [&_video]:w-full" />
                {cameraState === 'starting' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  </div>
                )}
                {looking && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70">
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                    <p className="text-xs text-white">{t('scan.lookingUp')}</p>
                  </div>
                )}
                {cameraState === 'running' && torchSupported && (
                  <button
                    type="button"
                    onClick={toggleTorch}
                    aria-label={t('scan.toggleTorch')}
                    className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-[#1F2937] shadow"
                  >
                    {torchOn ? <FlashlightOff className="h-5 w-5" /> : <Flashlight className="h-5 w-5" />}
                  </button>
                )}
              </div>
            )}

            {cameraState === 'denied' && (
              <div className="rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-4">
                <p className="text-sm font-medium text-[#1F2937]">{t('scan.cameraBlocked')}</p>
                <p className="mt-1 text-xs text-[#6B7280]">{t(CAMERA_DENIED_HELP_KEY)}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startCamera}
                  className="mt-3 h-9 rounded-lg border-[#E8E6E1] px-3 text-[13px] font-medium text-[#374151] hover:bg-[#F3F4F6] hover:text-[#1F2937]"
                >
                  {t('scan.retryCamera')}
                </Button>
              </div>
            )}

            <form onSubmit={handleManualSubmit} className="mt-3 flex items-center gap-2">
              <Input
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder={t('scan.manualPlaceholder')}
                disabled={looking}
                className="h-11 rounded-xl border-[#E8E6E1]"
              />
              <Button
                type="submit"
                disabled={looking || !manualValue.trim()}
                className="h-11 shrink-0 rounded-xl bg-[#2563EB] px-4 text-white hover:bg-[#2563EB]/90"
              >
                {t('scan.lookUp')}
              </Button>
            </form>
          </>
        )}

        {showNotFound && (
          <div className="rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-4 text-center">
            <p className="text-sm font-medium text-[#1F2937]">{t('scan.notFound')}</p>
            <p className="mt-2 break-all rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#6B7280]">
              {t('scan.scannedValue', { value: notFoundText })}
            </p>
            <Button
              onClick={handleScanAgain}
              className="mt-3 h-11 w-full rounded-xl bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
            >
              {t('scan.scanAgain')}
            </Button>
          </div>
        )}

        {showResult && (
          <div className="space-y-3">
            <div className="rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs text-[#6B7280]">
                    {result.stores?.shop_name || result.platform}
                  </p>
                  <p className="truncate text-lg font-bold text-[#1F2937]">
                    {result.buyer_name || t('scan.unknownBuyer')}
                  </p>
                </div>
                {/* An unmapped status keeps showing Shopee's raw string rather
                    than being mislabelled — same fallback as Orders' OTHER_TAB. */}
                <span
                  className={cn(
                    BADGE_CLS,
                    'shrink-0',
                    STATUS_BADGE[resultStatusKey] ?? DEFAULT_STATUS_BADGE
                  )}
                >
                  {resultStatusKey
                    ? t(`status.${resultStatusKey}`)
                    : result.order_status || t('scan.unknownStatus')}
                </span>
              </div>
              <div className="mt-2.5 space-y-1 text-xs text-[#6B7280]">
                <p>{t('scan.fields.order')}: {result.platform_order_id}</p>
                <p>{t('scan.fields.package')}: {result.package_number || '—'}</p>
                <p>{t('scan.fields.tracking')}: {result.tracking_number || '—'}</p>
              </div>
            </div>

            <div className="space-y-2.5">
              {(result.order_items ?? []).map((item) => {
                const qty = item.quantity ?? 1
                const unitPrice = Number(item.price) || 0
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-3"
                  >
                    {item.image_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewImage(item.image_url)}
                        aria-label={t('scan.viewImage')}
                        className="shrink-0 rounded-lg transition-transform active:scale-95"
                      >
                        <img
                          src={item.image_url}
                          alt=""
                          className="h-16 w-16 rounded-lg object-cover"
                        />
                      </button>
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-[#F3F4F6] text-[#9CA3AF]">
                        <Package className="h-7 w-7" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-bold text-[#1F2937]">
                        {item.product_name || t('scan.unnamedItem')}
                      </p>
                      {item.variant_name && (
                        <p className="truncate text-sm text-[#6B7280]">{item.variant_name}</p>
                      )}
                      <p className="truncate text-sm font-medium text-[#6B7280]">
                        {t('scan.fields.sku')}: {item.sku || '—'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-extrabold tabular-nums text-[#1F2937]">×{qty}</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-[#4B5563]">
                        RM {unitPrice.toFixed(2)}
                      </p>
                      {qty > 1 && (
                        <p className="text-base font-extrabold tabular-nums text-[#2563EB]">
                          RM {(unitPrice * qty).toFixed(2)}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
              {(result.order_items ?? []).length === 0 && (
                <div className="rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-4 text-center text-xs text-[#6B7280]">
                  {t('scan.noItems')}
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white border border-[#E8E6E1] shadow-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#6B7280]">{t('scan.fields.total')}</span>
                <span className="text-2xl font-extrabold tabular-nums text-[#1F2937]">
                  RM {(Number(result.total_amount) || 0).toFixed(2)}
                </span>
              </div>
            </div>

            <Button
              onClick={handleScanAgain}
              className="h-11 w-full rounded-xl bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
            >
              {t('scan.scanAnother')}
            </Button>
          </div>
        )}
      </section>

      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent
          showCloseButton={false}
          className="max-w-[calc(100%-2rem)] gap-0 rounded-2xl border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-md"
        >
          <DialogTitle className="sr-only">{t('scan.closePreview')}</DialogTitle>
          <button
            type="button"
            onClick={() => setPreviewImage(null)}
            aria-label={t('scan.closePreview')}
            className="w-full"
          >
            <img src={previewImage} alt="" className="w-full rounded-2xl object-contain" />
          </button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
