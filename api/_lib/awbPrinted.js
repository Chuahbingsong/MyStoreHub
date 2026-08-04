import { supabaseAdmin } from './supabaseAdmin.js';

/**
 * Flags orders as printed. Shared by print-awb.js (documentation only, no
 * longer calls this — see confirm-awb-printed.js) and confirm-awb-printed.js,
 * which is the only caller now: the client invokes it after the AWB PDF has
 * actually reached the device, not merely after Shopee generated it.
 */
export async function markOrdersPrinted(storeId, orderSnList) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .update({ awb_printed: true, awb_printed_at: new Date().toISOString() })
    .eq('store_id', storeId)
    .in('platform_order_id', orderSnList)
    .select('platform_order_id');

  if (error) {
    console.error('[awb-printed] failed to mark orders printed', error);
    return { markedCount: 0, error };
  }

  console.log('[awb-printed] marked', data?.length ?? 0, 'order(s) as printed');
  return { markedCount: data?.length ?? 0, error: null };
}
