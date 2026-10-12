import { describe, expect, it } from 'vitest'
import { roleHasPermission } from './permissions'

describe('roleHasPermission (#169)', () => {
  it('follows the catalog and denies unknown roles', () => {
    expect(roleHasPermission('Cashier', 'settle_bills')).toBe(true)
    expect(roleHasPermission('Waiter', 'settle_bills')).toBe(false)
    expect(roleHasPermission('Kitchen', 'settle_bills')).toBe(false)
    expect(roleHasPermission('Kitchen', 'fire_kitchen')).toBe(true)
    expect(roleHasPermission('Owner', 'refunds')).toBe(true)
    expect(roleHasPermission('Role-x', 'take_orders')).toBe(false)
    expect(roleHasPermission('constructor', 'take_orders')).toBe(false)
  })
})
