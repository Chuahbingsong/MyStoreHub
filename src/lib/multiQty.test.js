// Cases for piecesInVariant() / isMultiQty() / piecesToPack() in multiQty.js.
// Run: npm test   (plain `node --test`, no dependencies)
//
// Each row: [variant name, pieces per unit it should report (null = none)].
// Add a row whenever a real variant name is highlighted wrongly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMultiQty, piecesInVariant, piecesToPack } from './multiQty.js'

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
