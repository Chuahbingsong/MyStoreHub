// Shared helpers for printing Shopee AWB labels.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { FileOpener } from '@capacitor-community/file-opener'
import { apiUrl } from '@/lib/apiBase'

// Browsers throttle or block a burst of downloads fired back to back.
export const DOWNLOAD_STAGGER_MS = 800

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isNativePlatform() {
  return Capacitor.isNativePlatform()
}

/**
 * Downloads rather than window.open: mobile browsers block popups opened after
 * an await, and PWA standalone mode has no tab to render a blob: URL into.
 * A download hands the PDF to the phone's native viewer, which can print.
 * Browser/PWA only — the Capacitor WebView has no download manager to catch
 * this, which is why deliverPdf() below branches before ever calling it.
 */
export function downloadPdf(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking immediately can cancel the download on some mobile browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Saves a PDF into app-private cache storage and fires the native "Open with"
 * chooser (Shipping Printer Pro, Drive, WPS, etc.) — Android's equivalent of
 * a browser's download-then-tap-to-open flow. Cache dir needs no storage
 * permission and is exposed to other apps via FileOpener's FileProvider.
 */
async function openPdfNative(blob, filename) {
  const base64 = await blobToBase64(blob)
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  })
  try {
    await FileOpener.open({ filePath: uri, contentType: 'application/pdf' })
  } catch (err) {
    // The PDF is already saved at this point; the user declining or having no
    // matching app in the chooser isn't a delivery failure, just a UI outcome.
    console.warn('[awb] FileOpener could not open the saved PDF', err)
  }
}

/**
 * Single entry point both platforms funnel through. Resolves only once the
 * PDF has genuinely reached the device — a thrown error here means it did
 * not, and callers must not mark the order as printed in that case.
 */
export async function deliverPdf(blob, filename) {
  if (isNativePlatform()) {
    await openPdfNative(blob, filename)
    return
  }
  // A browser gives JS no completion callback for a download — triggering it
  // is the strongest delivery signal available, same as before this change.
  downloadPdf(blob, filename)
}

/**
 * Tells the server a batch of orders' AWBs actually reached the device, so it
 * can flip awb_printed. Called only after deliverPdf() resolves for those
 * orders — see api/shopee/confirm-awb-printed.js for why this is a separate
 * step from print-awb rather than something print-awb does itself.
 */
export async function confirmAwbPrinted(accessToken, storeId, orderSnList) {
  if (!orderSnList?.length) return
  try {
    const res = await fetch(apiUrl('/api/shopee/confirm-awb-printed'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ store_id: storeId, order_sn_list: orderSnList }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      console.error('[awb] failed to confirm printed orders', data)
    }
  } catch (err) {
    console.error('[awb] failed to confirm printed orders', err)
  }
}

export function base64ToPdfBlob(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: 'application/pdf' })
}

export function slugify(value, fallback = 'unknown') {
  return (
    String(value ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}

export function describeFailedOrders(failedOrders = []) {
  return failedOrders
    .map((entry) => `${entry.order_sn}: ${entry.reason || entry.fail_message || entry.fail_error}`)
    .join('; ')
}

/**
 * Turns a failed /api/shopee/print-awb body into something worth reading.
 * Shopee's top-level message is often just "All failed, please check
 * result_list for detail" — the real reason is per-order inside result_list.
 */
export function printAwbErrorMessage(data, fallback = 'Failed to print AWB.') {
  // The server already extracts per-order failures; prefer them.
  const fromFailedOrders = describeFailedOrders(data?.failed ?? data?.failed_orders)
  if (fromFailedOrders) return fromFailedOrders

  const resultList = data?.shopee_response?.response?.result_list ?? []
  const detail = resultList
    .filter((entry) => entry.fail_message || entry.fail_error)
    .map((entry) => `${entry.order_sn}: ${entry.fail_message || entry.fail_error}`)
    .join('; ')

  if (detail) return detail
  // Orders with no tracking number come back with an already-readable reason.
  if (data?.skipped_orders?.length) return data.error || fallback
  if (data?.error) return data.step ? `${data.error} (failed at ${data.step})` : data.error
  return fallback
}

/**
 * The response body carries the full Shopee payload; log it whole so the real
 * reason is in the console even when the toast is truncated.
 */
export function logPrintAwbFailure(context, data) {
  console.log(
    `[print-awb] ${context} failed at step "${data?.step ?? 'unknown'}"`,
    '\nerror:',
    data?.error,
    '\nfull response:',
    JSON.stringify(data, null, 2)
  )
}

/**
 * Android and iOS have no shared "open with" trigger a website can invoke —
 * only the user's own tap on the OS download notification / share icon does
 * that. This just tells the UI which one-time hint copy applies.
 */
export function detectAwbHintPlatform() {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent || ''
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  return null
}

const AWB_HINT_SEEN_KEY = 'mystorehub.awbOpenWithHintSeen'

export function hasSeenAwbOpenWithHint() {
  try {
    return localStorage.getItem(AWB_HINT_SEEN_KEY) === '1'
  } catch {
    // Storage unavailable (private mode, etc.) — don't force the hint every time.
    return true
  }
}

export function markAwbOpenWithHintSeen() {
  try {
    localStorage.setItem(AWB_HINT_SEEN_KEY, '1')
  } catch {
    // Ignore — worst case the hint reappears next time.
  }
}

/**
 * Delivers whatever PDFs a print-awb JSON response carries.
 * Normally one file; `documents` appears only when Shopee refused to combine
 * the batch and the server fell back to one PDF per order.
 * Returns { fileCount, deliveredOrderSns }: fileCount for the toast, and
 * deliveredOrderSns — only the orders whose PDF actually reached the device —
 * for the caller to pass to confirmAwbPrinted. A PDF that fails to deliver is
 * excluded from deliveredOrderSns rather than aborting the rest of the batch.
 */
export async function downloadAwbResponse(data, filename) {
  if (data?.documents?.length) {
    let isFirst = true
    let fileCount = 0
    const deliveredOrderSns = []
    for (const doc of data.documents) {
      if (!isFirst) await sleep(DOWNLOAD_STAGGER_MS)
      isFirst = false
      try {
        await deliverPdf(
          base64ToPdfBlob(doc.pdf_base64),
          doc.filename || `AWB-${doc.order_sn_list?.[0] ?? 'label'}.pdf`
        )
        fileCount += 1
        deliveredOrderSns.push(...(doc.order_sn_list ?? []))
      } catch (err) {
        console.error('[awb] failed to deliver PDF for', doc.order_sn_list, err)
      }
    }
    return { fileCount, deliveredOrderSns }
  }

  if (data?.pdf_base64) {
    try {
      await deliverPdf(base64ToPdfBlob(data.pdf_base64), filename)
      return { fileCount: 1, deliveredOrderSns: data.printed_order_sn_list ?? [] }
    } catch (err) {
      console.error('[awb] failed to deliver PDF', err)
      return { fileCount: 0, deliveredOrderSns: [] }
    }
  }

  return { fileCount: 0, deliveredOrderSns: [] }
}
