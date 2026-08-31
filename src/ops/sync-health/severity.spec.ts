// CAP-6 severity classification thresholds (SPEC success criteria): silent
// past 48h, lagging past 1h, healthy otherwise. Boundaries pinned exactly.
import { describe, expect, it } from 'vitest'
import { classifySeverity, compareSeverity, LAGGING_THRESHOLD_SECONDS, SILENT_THRESHOLD_SECONDS } from './severity'

describe('classifySeverity', () => {
  it('is healthy at and below the 1h lagging threshold', () => {
    expect(classifySeverity(0)).toBe('healthy')
    expect(classifySeverity(LAGGING_THRESHOLD_SECONDS - 1)).toBe('healthy')
    expect(classifySeverity(LAGGING_THRESHOLD_SECONDS)).toBe('healthy')
  })

  it('is lagging just past 1h and up to the 48h silent threshold', () => {
    expect(classifySeverity(LAGGING_THRESHOLD_SECONDS + 1)).toBe('lagging')
    expect(classifySeverity(SILENT_THRESHOLD_SECONDS - 1)).toBe('lagging')
    expect(classifySeverity(SILENT_THRESHOLD_SECONDS)).toBe('lagging')
  })

  it('is silent past 48h', () => {
    expect(classifySeverity(SILENT_THRESHOLD_SECONDS + 1)).toBe('silent')
    expect(classifySeverity(SILENT_THRESHOLD_SECONDS * 10)).toBe('silent')
  })
})

describe('compareSeverity', () => {
  it('orders silent before lagging before healthy', () => {
    const order = ['healthy', 'silent', 'lagging', 'healthy', 'silent'] as const
    const sorted = [...order].sort(compareSeverity)
    expect(sorted).toEqual(['silent', 'silent', 'lagging', 'healthy', 'healthy'])
  })
})
