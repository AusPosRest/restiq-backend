import { describe, expect, it } from 'vitest'
import { localIsoWithOffset } from './reports.service'

describe('localIsoWithOffset (PE-23)', () => {
  it('writes the outlet wall-clock time with its UTC offset', () => {
    const instant = new Date('2026-10-11T13:05:03.487Z')
    expect(localIsoWithOffset(instant, 'Asia/Kolkata')).toBe('2026-10-11T18:35:03+05:30')
    expect(localIsoWithOffset(instant, 'Australia/Sydney')).toBe('2026-10-12T00:05:03+11:00')
    expect(localIsoWithOffset(instant, 'UTC')).toBe('2026-10-11T13:05:03+00:00')
  })
})
