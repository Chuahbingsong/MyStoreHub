// THROWAWAY probe — confirms the boost_item WRITE shape on Big Hammer (or Meow
// Fun Toy). Two modes so we can inspect+report BEFORE boosting:
//   node _boost_write_probe.mjs inspect
//   node _boost_write_probe.mjs boost <item_id>
// Deleted after use.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const { generateSign, SHOPEE_PARTNER_ID, SHOPEE_API_BASE } = await import('./api/_lib/shopee.js');
const { supabaseAdmin } = await import('./api/_lib/supabaseAdmin.js');
const { ensureFreshToken } = await import('./api/_lib/shopeeSync.js');

const mode = process.argv[2];
const argItemId = process.argv[3];
const nowUnix = () => Math.floor(Date.now() / 1000);

// Prefer Big Hammer, fall back to Meow Fun.
const { data: stores, error } = await supabaseAdmin
  .from('stores')
  .select('*')
  .eq('platform', 'shopee')
  .or('shop_name.ilike.%Big Hammer%,shop_name.ilike.%Meow Fun%');
if (error) throw error;
if (!stores?.length) throw new Error('Neither Big Hammer nor Meow Fun store found');

// Deterministic: Big Hammer first, unless a name filter is passed as the last arg.
const nameFilter = process.argv.find((a) => a.startsWith('--store='))?.slice('--store='.length);
const store0 = nameFilter
  ? stores.find((s) => new RegExp(nameFilter, 'i').test(s.shop_name)) ?? stores[0]
  : stores.find((s) => /big hammer/i.test(s.shop_name)) ?? stores[0];
const store = await ensureFreshToken(store0);
console.log('STORE:', store.shop_name, '| shop_id:', store.shop_id, '| id:', store.id);

async function getBoostedList() {
  const path = '/api/v2/product/get_boosted_list';
  const ts = nowUnix();
  const sign = generateSign(path, ts, store.access_token, store.shop_id);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID, timestamp: String(ts),
    access_token: store.access_token, shop_id: String(store.shop_id), sign,
  });
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  return { status: res.status, body: await res.json() };
}

if (mode === 'inspect') {
  const boosted = await getBoostedList();
  console.log('\n=== get_boosted_list ===');
  console.log('HTTP', boosted.status);
  console.log(JSON.stringify(boosted.body, null, 2));

  const list = boosted.body.response?.item_list ?? [];
  const occupiedIds = new Set(
    list.filter((b) => (b.cool_down_second ?? 0) > 0).map((b) => String(b.item_id))
  );
  console.log(`\nOccupied slots: ${occupiedIds.size}/5 | free: ${5 - occupiedIds.size}`);

  // Candidate item_ids from our synced catalogue for this store, skipping any
  // already boosted. Prefer in-stock, NORMAL status.
  const { data: products } = await supabaseAdmin
    .from('products')
    .select('platform_product_id, title, stock, status')
    .eq('store_id', store.id);
  const candidates = (products ?? [])
    .filter((p) => !occupiedIds.has(String(p.platform_product_id)))
    .sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))
    .slice(0, 8);
  console.log('\n=== candidate item_ids (not currently boosted) ===');
  for (const c of candidates) {
    console.log(`  ${c.platform_product_id}  stock=${c.stock ?? 0}  status=${c.status}  "${(c.title ?? '').slice(0, 40)}"`);
  }
  console.log(`\nTotal synced products for store: ${products?.length ?? 0}`);
} else if (mode === 'boost') {
  if (!argItemId) throw new Error('Usage: boost <item_id>');
  const itemId = Number(argItemId);

  // ---- the actual write ----
  const path = '/api/v2/product/boost_item';
  const ts = nowUnix();
  const sign = generateSign(path, ts, store.access_token, store.shop_id);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID, timestamp: String(ts),
    access_token: store.access_token, shop_id: String(store.shop_id), sign,
  });
  const requestBody = { item_id_list: [itemId] };

  console.log('\n=== boost_item REQUEST ===');
  console.log('POST', path);
  console.log('query:', `partner_id=${SHOPEE_PARTNER_ID}&timestamp=${ts}&shop_id=${store.shop_id}&access_token=<redacted>&sign=<redacted>`);
  console.log('body :', JSON.stringify(requestBody));

  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const body = await res.json();
  console.log('\n=== boost_item RAW RESPONSE ===');
  console.log('HTTP', res.status);
  console.log(JSON.stringify(body, null, 2));

  // ---- verify ----
  await new Promise((r) => setTimeout(r, 2000));
  const after = await getBoostedList();
  console.log('\n=== verification: get_boosted_list AFTER ===');
  console.log('HTTP', after.status);
  console.log(JSON.stringify(after.body, null, 2));

  const nowBoosted = (after.body.response?.item_list ?? []).some(
    (b) => String(b.item_id) === String(itemId) && (b.cool_down_second ?? 0) > 0
  );
  console.log(`\nVERDICT: item ${itemId} ${nowBoosted ? 'IS now boosting ✅ — write shape CONFIRMED' : 'is NOT boosting ❌ — write shape likely wrong'}`);
} else {
  console.log('Usage: node _boost_write_probe.mjs inspect | boost <item_id>');
}
