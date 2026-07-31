// Shared helpers for printing Shopee AWB labels.

// Browsers throttle or block a burst of downloads fired back to back.
export const DOWNLOAD_STAGGER_MS = 800

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Downloads rather than window.open: mobile browsers block popups opened after
 * an await, and PWA standalone mode has no tab to render a blob: URL into.
 * A download hands the PDF to the phone's native viewer, which can print.
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
 * Downloads whatever PDFs a print-awb JSON response carries.
 * Normally one file; `documents` appears only when Shopee refused to combine
 * the batch and the server fell back to one PDF per order.
 * Returns the number of files downloaded.
 */
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

export async function downloadAwbResponse(data, filename) {
  if (data?.documents?.length) {
    let isFirst = true
    for (const doc of data.documents) {
      if (!isFirst) await sleep(DOWNLOAD_STAGGER_MS)
      downloadPdf(
        base64ToPdfBlob(doc.pdf_base64),
        doc.filename || `AWB-${doc.order_sn_list?.[0] ?? 'label'}.pdf`
      )
      isFirst = false
    }
    return data.documents.length
  }

  if (data?.pdf_base64) {
    downloadPdf(base64ToPdfBlob(data.pdf_base64), filename)
    return 1
  }

  return 0
}
