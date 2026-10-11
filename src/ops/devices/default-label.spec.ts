import { describe, expect, it } from 'vitest'
import { uuidv7 } from '../../platform'
import { defaultLabel } from './devices.service'

describe('defaultLabel (PE-25)', () => {
  it('gives two devices enrolled in the same instant different labels', () => {
    const labels = new Set(Array.from({ length: 50 }, () => defaultLabel('pos', uuidv7())))
    expect(labels.size).toBe(50)
  })

  it('reads TYPE-XXXXXX from the random tail of the id', () => {
    expect(defaultLabel('kds', '01a12b07-0000-7000-8000-00000abc1234')).toBe('KDS-BC1234')
  })
})
