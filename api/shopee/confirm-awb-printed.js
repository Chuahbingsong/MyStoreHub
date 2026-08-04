import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { markOrdersPrinted } from '../_lib/awbPrinted.js';
import { withCors } from '../_lib/cors.js';

/**
 * Marks orders printed. Split out of print-awb.js on purpose: that endpoint
 * only proves Shopee generated the label PDF, not that it reached the
 * seller's device. The client calls this endpoint only after the PDF has
 * actually been saved (native) or handed to the browser's downloader (web) —
 * see deliverPdf()/confirmAwbPrinted() in src/lib/awb.js.
 */
export default withCors(handler);

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    console.error('[confirm-awb-printed] auth verification failed', authError);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { store_id, order_sn_list } = req.body ?? {};

  if (!store_id) {
    return res.status(400).json({ success: false, error: 'store_id is required' });
  }

  if (!Array.isArray(order_sn_list) || order_sn_list.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: 'order_sn_list must be a non-empty array' });
  }

  const { data: store, error: storeLookupError } = await supabaseAdmin
    .from('stores')
    .select('id, user_id')
    .eq('id', store_id)
    .eq('platform', 'shopee')
    .maybeSingle();

  if (storeLookupError) {
    console.error('[confirm-awb-printed] failed to load store', storeLookupError);
    return res.status(500).json({ success: false, error: 'Failed to load store from Supabase' });
  }

  if (!store) {
    return res.status(404).json({ success: false, error: 'No matching Shopee store found' });
  }

  if (store.user_id !== user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const { markedCount, error } = await markOrdersPrinted(store.id, order_sn_list);

  if (error) {
    return res.status(500).json({ success: false, error: 'Failed to record printed orders' });
  }

  return res.status(200).json({ success: true, marked_count: markedCount });
}
