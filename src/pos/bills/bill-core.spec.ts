import { describe, expect, it } from 'vitest'
import { cashRoundOffMinor } from './bill-core'

// restiq-backend#241 (Q28): cash settles to the nearest Rs 1 (IN) or 5c (AU), halves up.
describe('cashRoundOffMinor', () => {
  it('IN: rounds to the nearest rupee', () => {
    expect(cashRoundOffMinor(24046n, 'IN')).toBe(-46n)
    expect(cashRoundOffMinor(8296n, 'IN')).toBe(4n)
    expect(cashRoundOffMinor(8250n, 'IN')).toBe(50n)
    expect(cashRoundOffMinor(30000n, 'IN')).toBe(0n)
  })

  it('AU: rounds to the nearest 5c', () => {
    expect(cashRoundOffMinor(1234n, 'AU')).toBe(1n)
    expect(cashRoundOffMinor(1232n, 'AU')).toBe(-2n)
    expect(cashRoundOffMinor(1235n, 'AU')).toBe(0n)
  })

  it('never rounds nothing or a negative share', () => {
    expect(cashRoundOffMinor(0n, 'IN')).toBe(0n)
    expect(cashRoundOffMinor(-46n, 'AU')).toBe(0n)
  })
})
