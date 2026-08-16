import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin.js';

// Private bucket; nothing here is ever served directly to a browser. The
// print endpoint proxies the bytes with the service-role key rather than
// handing out signed URLs, so no Storage RLS policy is required.
export const AWB_BUCKET = 'awb-documents';

/**
 * Statuses whose label must never come from cache, whatever the fingerprint
 * says. order_status is part of the fingerprint, so a transition into one of
 * these already invalidates it — this is the belt-and-braces check, covering
 * the case where a label was somehow cached while already in this state.
 */
export const CACHE_BLOCKED_STATUSES = new Set(['CANCELLED', 'IN_CANCEL', 'TO_RETURN']);

// The order fields a cached PDF's contents depend on. Named here so the
// fingerprint and its diagnostics can't drift apart.
export const FINGERPRINT_FIELDS = [
  'tracking_number',
  'order_status',
  'courier_name',
  'shipping_address',
];

/**
 * Identifies the order state a cached label was generated from. If any of
 * these change, the stored PDF may carry a stale barcode or address, so the
 * print path regenerates instead of serving it.
 *
 * Joined with a delimiter rather than concatenated so that neighbouring
 * fields can't collide ("AB"+"C" must not hash the same as "A"+"BC").
 */
export function awbCacheFingerprint(order) {
  const parts = FINGERPRINT_FIELDS.map((field) => order[field] ?? '');
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function awbStoragePath(storeId, orderSn) {
  return `${storeId}/${orderSn}.pdf`;
}

/**
 * Whether one order's cached label can be trusted right now.
 * Returns { ok } or { ok: false, reason, detail } — reason is a stable slug
 * for the RESULT= logs, detail is the human-readable part.
 */
export function cacheEligibility(order) {
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (!order.awb_cached_path) return { ok: false, reason: 'not_cached' };

  if (CACHE_BLOCKED_STATUSES.has(order.order_status)) {
    return { ok: false, reason: 'blocked_status', detail: order.order_status };
  }

  if (!order.awb_cache_fingerprint) {
    return { ok: false, reason: 'no_fingerprint' };
  }

  const current = awbCacheFingerprint(order);
  if (current !== order.awb_cache_fingerprint) {
    return {
      ok: false,
      reason: 'fingerprint_mismatch',
      // A composite hash cannot be reversed, so the field that actually
      // changed is not recoverable — only the current values are. Reported
      // so the change is at least identifiable by eye against the order.
      detail: FINGERPRINT_FIELDS.map((field) => `${field}=${JSON.stringify(order[field] ?? null)}`).join(' '),
      expected: order.awb_cache_fingerprint,
      actual: current,
    };
  }

  return { ok: true };
}

/**
 * Downloads a cached PDF. Returns a Buffer only when the object exists and
 * genuinely looks like a PDF; null on every other outcome. Never throws — a
 * cache miss must be invisible to the caller, which then generates live.
 */
export async function readCachedAwbPdf(path) {
  try {
    const { data, error } = await supabaseAdmin.storage.from(AWB_BUCKET).download(path);

    if (error) {
      console.log(`[print-awb] cache read failed for ${path}: ${error.message}`);
      return null;
    }
    if (!data) {
      console.log(`[print-awb] cache read returned no data for ${path}`);
      return null;
    }

    const buffer = Buffer.from(await data.arrayBuffer());

    // A row pointing at a truncated or non-PDF object is worse than no cache.
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      console.log(`[print-awb] cached object at ${path} is not a PDF (${buffer.length} bytes); ignoring`);
      return null;
    }

    return buffer;
  } catch (err) {
    console.log(`[print-awb] cache read threw for ${path}: ${err.message}`);
    return null;
  }
}
