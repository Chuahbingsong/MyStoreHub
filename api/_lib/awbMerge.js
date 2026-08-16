import { PDFDocument } from 'pdf-lib';
import { readCachedAwbPdf } from './awbCache.js';

// Storage downloads are independent, so they overlap. Capped so a large
// merge doesn't open a connection per order all at once.
export const CACHE_FETCH_CONCURRENCY = 6;

// Sorts unknown couriers last rather than first: they are the exceptions an
// operator wants at the end of the stack, not interleaved at the front.
const COURIER_LAST = '￿';

async function mapWithConcurrency(items, limit, fn) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Merge order: courier first, then oldest order first within a courier.
 * Courier is primary so the printed stack can be split by courier without
 * re-sorting — the whole point of controlling the order server-side.
 */
export function sortForMerge(orders) {
  return [...orders].sort((a, b) => {
    const courierA = a.courier_name || COURIER_LAST;
    const courierB = b.courier_name || COURIER_LAST;
    if (courierA !== courierB) return courierA.localeCompare(courierB);

    const createdA = a.order_created_at ? Date.parse(a.order_created_at) : 0;
    const createdB = b.order_created_at ? Date.parse(b.order_created_at) : 0;
    if (createdA !== createdB) return createdA - createdB;

    // Stable tiebreak so the same batch always merges in the same order.
    return String(a.platform_order_id).localeCompare(String(b.platform_order_id));
  });
}

/**
 * Concatenates PDFs into one document, preserving the given order.
 *
 * A single buffer is returned untouched rather than round-tripped through
 * pdf-lib: that keeps the single-order print path byte-for-byte what it was
 * before merging existed, and avoids re-encoding a label for no reason.
 *
 * Returns null if there is nothing usable to merge. Individual unreadable
 * PDFs are skipped rather than failing the batch, because a merge that drops
 * one label is still better than no labels — callers that need
 * all-or-nothing check the count themselves.
 */
export async function mergePdfBuffers(buffers) {
  const usable = buffers.filter((buf) => buf && buf.length > 0);
  if (usable.length === 0) return null;

  // Passthrough still has to prove it is a PDF. Callers currently only hand
  // over pre-validated buffers, but returning an unchecked one here would
  // make this function the single place a corrupt label could reach a
  // printer, which is exactly what the merge path is meant to prevent.
  if (usable.length === 1) {
    return usable[0].subarray(0, 5).toString('latin1') === '%PDF-' ? usable[0] : null;
  }

  const merged = await PDFDocument.create();

  for (const buf of usable) {
    try {
      // Shopee's labels are not encrypted, but a courier-specific document
      // occasionally carries permission flags that would otherwise throw.
      const source = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } catch (err) {
      console.error('[print-awb] skipping a PDF that failed to parse during merge:', err.message);
    }
  }

  if (merged.getPageCount() === 0) return null;

  return Buffer.from(await merged.save());
}

/**
 * Downloads every order's cached PDF. Returns a Map keyed by order SN,
 * containing only the ones that came back as valid PDFs — a caller
 * requiring all of them compares map.size against the input length.
 */
export async function fetchCachedPdfs(orders, concurrency = CACHE_FETCH_CONCURRENCY) {
  const byOrderSn = new Map();

  await mapWithConcurrency(orders, concurrency, async (order) => {
    const buffer = await readCachedAwbPdf(order.awb_cached_path);
    if (buffer) byOrderSn.set(order.platform_order_id, buffer);
  });

  return byOrderSn;
}
