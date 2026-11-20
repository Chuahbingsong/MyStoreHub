// Cases for piecesInVariant() / isMultiQty() / piecesToPack() /
// multiQtyLabels() in multiQty.js.
// Run: npm test   (plain `node --test`, no dependencies)
//
// Each row: [variant name, pieces per unit it should report (null = none)].
// Add a row whenever a real variant name is highlighted wrongly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMultiQty, multiQtyLabels, piecesInVariant, piecesToPack } from './multiQty.js'
import en from './i18n/translations/en.js'
import zhCN from './i18n/translations/zh-CN.js'

// Same lookup as I18nProvider's t(): exact key, else _one/_other on `count`,
// then {{var}} interpolation — so these tests check the real dictionary text.
function translator(dict) {
  const resolve = (key) => key.split('.').reduce((acc, part) => acc?.[part], dict)
  return (key, vars) => {
    let value = resolve(key)
    if (typeof value !== 'string') value = resolve(`${key}_${vars.count === 1 ? 'one' : 'other'}`)
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m))
  }
}

export const PIECE_CASES = [
  // --- should trigger (2+ pieces) ---
  ['2pcs', 2],
  ['2 pcs', 2],
  ['2PCS', 2],
  ['3pc', 3],
  ['2 pieces', 2],
  ['2件', 2],
  ['2 biji', 2],
  ['Set of 2', 2],
  ['x2', 2],
  ['X 2', 2],
  ['2个', 2],
  ['2个装', 2],
  ['3 个', 3],
  ['Black, 2pcs', 2],
  ['Red (2 Pcs)', 2],
  ['Blue x3', 3],
  ['12pcs', 12],
  ['2件套', 2],
  // --- should NOT trigger ---
  ['2 in 1', null], // a 2-in-1 product is usually a single item
  ['3in1', null],
  ['1个', null],
  ['1pcs', null],
  ['1 pc', null],
  ['Set of 1', null],
  ['x1', null],
  ['250ml', null],
  ['12V', null],
  ['Size 2', null],
  ['Age 3+', null],
  ['2XL', null],
  ['Model A2', null],
  ['RTX2080', null],
  ['X200', null],
  ['60x90cm', null],
  ['60 x 90 cm', null],
  ['Pack x2m', null],
  ['Type-C 2.0', null],
  ['2m cable', null],
  ['3 inch', null],
  ['100pcs stickers', null],
  ['', null],
  [null, null],
]

test('piecesInVariant cases', () => {
  const failures = PIECE_CASES.filter(([variant, want]) => piecesInVariant(variant) !== want).map(
    ([variant, want]) => `${JSON.stringify(variant)}: want ${want}, got ${piecesInVariant(variant)}`
  )
  assert.deepEqual(failures, [])
})

test('isMultiQty: quantity alone, variant alone, neither', () => {
  assert.equal(isMultiQty(2, 'Red'), true)
  assert.equal(isMultiQty(1, '2pcs'), true)
  assert.equal(isMultiQty(1, '250ml'), false)
  assert.equal(isMultiQty(1, undefined), false)
})

test('piecesToPack = qty × pieces in variant', () => {
  assert.equal(piecesToPack(1, '2pcs'), 2)
  assert.equal(piecesToPack(2, '3pcs'), 6)
  assert.equal(piecesToPack(3, 'Red'), 3)
})

test('labels: variant with a piece count spells the sum out (en)', () => {
  const t = translator(en)
  // The case that was packed as 8: qty 2 of "2pcs" is 4 pieces, not "x4 pcs".
  assert.deepEqual(multiQtyLabels(2, '2pcs', t), { qty: 'x2 sets', total: '= 4 pcs total', thumb: '4 pcs' })
  assert.deepEqual(multiQtyLabels(1, '2pcs', t), { qty: 'x1 set', total: '= 2 pcs total', thumb: '2 pcs' })
  assert.deepEqual(multiQtyLabels(2, '3pcs', t, '×'), { qty: '×2 sets', total: '= 6 pcs total', thumb: '6 pcs' })
})

test('labels: variant with a piece count (zh-CN)', () => {
  const t = translator(zhCN)
  assert.deepEqual(multiQtyLabels(2, '2pcs', t), { qty: 'x2 套', total: '= 共 4 件', thumb: '4 件' })
  assert.deepEqual(multiQtyLabels(1, '2件', t, '×'), { qty: '×1 套', total: '= 共 2 件', thumb: '2 件' })
})

test('labels: no piece count keeps the plain "x2" with no total', () => {
  for (const dict of [en, zhCN]) {
    const t = translator(dict)
    assert.deepEqual(multiQtyLabels(2, 'Red', t), { qty: 'x2', total: null, thumb: 'x2' })
    assert.deepEqual(multiQtyLabels(3, undefined, t, '×'), { qty: '×3', total: null, thumb: '×3' })
    // Multipacks sold as one item aren't a piece count either.
    assert.deepEqual(multiQtyLabels(2, '100pcs stickers', t), { qty: 'x2', total: null, thumb: 'x2' })
  }
})

test('labels: no bare "x<total> pcs" anywhere', () => {
  for (const dict of [en, zhCN]) {
    const { qty, total, thumb } = multiQtyLabels(2, '2pcs', translator(dict))
    for (const label of [qty, total, thumb]) assert.doesNotMatch(label, /^x4/)
  }
})
