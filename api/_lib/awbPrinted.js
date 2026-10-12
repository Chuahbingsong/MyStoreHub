import { supabaseAdmin } from './supabaseAdmin.js';

// Mirrors the check constraint on awb_print_events.print_mode. 'unknown' is
// deliberately absent: it exists only for rows the migration backfilled from
// awb_printed_at, never for a print this code records.
const PRINT_MODES = ['single', 'bulk'];

/**
 * Flags orders as printed and appends one row per order to the print history.
 * Shared by print-awb.js (documentation only, no longer calls this — see
 * confirm-awb-printed.js) and confirm-awb-printed.js, which is the only caller
 * now: the client invokes it after the AWB PDF has actually reached the
 * device, not merely after Shopee generated it.
 *
 * awb_printed_at is written ONLY when it is still null, so it holds the FIRST
 * print. It used to be overwritten on every confirm, which silently discarded
 * the earlier timestamp whenever an order was printed twice; the awb_print_events
 * rows now carry every print and the column carries the first. awb_printed is
 * still set unconditionally — BulkPrint's "unprinted" filter and
 * awbPrintAll.js's query both read it, and neither cares how many times.
 *
 * `mode` records how the print was triggered ('single' or 'bulk'); anything
 * else falls back to 'single' rather than failing, since a mislabelled history
 * entry is better than a lost one.
 */
export async function markOrdersPrinted(storeId, orderSnList, { mode = 'single' } = {}) {
  const printMode = PRINT_MODES.includes(mode) ? mode : 'single';
  const printedAt = new Date().toISOString();

  // Read before writing: the history rows key on orders.id, which the SN list
  // does not carry, and "set awb_printed_at only if null" needs to know which
  // rows are still null. PostgREST cannot express coalesce() in an update, so
  // the split is done here instead of in SQL.
  const { data: rows, error: lookupError } = await supabaseAdmin
    .from('orders')
    .select('id, platform_order_id, awb_printed_at')
    .eq('store_id', storeId)
    .in('platform_order_id', orderSnList);

  if (lookupError) {
    console.error('[awb-printed] failed to load orders to mark printed', lookupError);
    return { markedCount: 0, historyCount: 0, error: lookupError, historyError: null };
  }

  if (!rows?.length) {
    console.warn('[awb-printed] no matching orders for', orderSnList.length, 'order SN(s)');
    return { markedCount: 0, historyCount: 0, error: null, historyError: null };
  }

  const orderIds = rows.map((row) => row.id);

  // The flags first: they are what the rest of the app reads, so a failure
  // here is fatal to the request while a history failure below is not.
  const { error: flagError } = await supabaseAdmin
    .from('orders')
    .update({ awb_printed: true })
    .in('id', orderIds);

  if (flagError) {
    console.error('[awb-printed] failed to flag orders printed', flagError);
    return { markedCount: 0, historyCount: 0, error: flagError, historyError: null };
  }

  // First print only. Filtered on id (not SN) so the set is exactly the rows
  // that were null at lookup time, and re-filtered on `is null` so a confirm
  // racing another one for the same order cannot overwrite the winner's value.
  const firstPrintIds = rows.filter((row) => !row.awb_printed_at).map((row) => row.id);

  if (firstPrintIds.length > 0) {
    const { error: firstPrintError } = await supabaseAdmin
      .from('orders')
      .update({ awb_printed_at: printedAt })
      .in('id', firstPrintIds)
      .is('awb_printed_at', null);

    if (firstPrintError) {
      console.error('[awb-printed] failed to set first-print timestamp', firstPrintError);
      return {
        markedCount: 0,
        historyCount: 0,
        error: firstPrintError,
        historyError: null,
      };
    }
  }

  // The history. Non-fatal on purpose: the label HAS been printed by the time
  // this runs, and failing the request would leave the caller believing
  // otherwise and the flags already written. Logged loudly and reported back
  // so the endpoint can surface it as a warning instead.
  const { data: events, error: historyError } = await supabaseAdmin
    .from('awb_print_events')
    .insert(
      rows.map((row) => ({
        order_id: row.id,
        store_id: storeId,
        platform_order_id: row.platform_order_id,
        printed_at: printedAt,
        print_mode: printMode,
      }))
    )
    .select('id');

  if (historyError) {
    console.error('[awb-printed] failed to record print history', historyError);
  }

  console.log(
    '[awb-printed] marked',
    rows.length,
    `order(s) as printed (${printMode}),`,
    events?.length ?? 0,
    'history row(s) recorded'
  );

  return {
    markedCount: rows.length,
    historyCount: events?.length ?? 0,
    error: null,
    historyError: historyError ?? null,
  };
}
