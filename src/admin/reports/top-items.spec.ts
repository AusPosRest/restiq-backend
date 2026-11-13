import { describe, expect, it } from 'vitest'
import { aggregateTopItems, type TopItemLine } from './reports.service'

function line(overrides: Partial<TopItemLine>): TopItemLine {
  return { itemId: 'dosa', variantId: null, comboId: null, quantity: 1, unitPriceMinor: 10000n, item: { name: 'Dosa' }, variant: null, combo: null, modifiers: [], ...overrides }
}

describe('aggregateTopItems (restiq-backend#288)', () => {
  it('groups by item + portion, adds modifiers to the line total, and sorts by quantity then sales', () => {
    const rows = aggregateTopItems([
      line({ quantity: 2, modifiers: [{ priceMinor: 500n }] }), // 2 x (100 + 5)
      line({ quantity: 1 }),
      line({ itemId: 'biryani', variantId: 'half', item: { name: 'Biryani' }, variant: { name: 'Half' }, quantity: 3, unitPriceMinor: 20000n }),
      line({ itemId: 'biryani', variantId: 'full', item: { name: 'Biryani' }, variant: { name: 'Full' }, quantity: 3, unitPriceMinor: 35000n }),
      line({ itemId: 'tea', item: { name: 'Tea' }, quantity: 1, unitPriceMinor: 2000n }),
    ])
    expect(rows).toEqual([
      { id: 'biryani', variantId: 'full', name: 'Biryani', portionName: 'Full', quantity: 3, salesMinor: 105000 },
      { id: 'biryani', variantId: 'half', name: 'Biryani', portionName: 'Half', quantity: 3, salesMinor: 60000 },
      { id: 'dosa', variantId: null, name: 'Dosa', portionName: null, quantity: 3, salesMinor: 31000 },
      { id: 'tea', variantId: null, name: 'Tea', portionName: null, quantity: 1, salesMinor: 2000 },
    ])
  })

  it('counts a combo under its own name and its chosen items at their upcharge', () => {
    const rows = aggregateTopItems([
      line({ itemId: null, comboId: 'meal', item: null, combo: { name: 'Meal Deal' }, quantity: 2, unitPriceMinor: 30000n }),
      line({ quantity: 2, unitPriceMinor: 0n }),
    ])
    expect(rows).toEqual([
      { id: 'meal', variantId: null, name: 'Meal Deal', portionName: null, quantity: 2, salesMinor: 60000 },
      { id: 'dosa', variantId: null, name: 'Dosa', portionName: null, quantity: 2, salesMinor: 0 },
    ])
  })
})
