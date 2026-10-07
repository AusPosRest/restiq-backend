// restiq-backend#169: the one permission catalog the API enforces. The owner's
// Staff screen shows this same table (GET /admin/v1/roles returns each role's
// permissions). Keyed by system role name - roles are the fixed set Platform
// Console seeds per tenant (ops/tenants SYSTEM_ROLES); any other name gets
// nothing. Manager-PIN approval (ManagerAuthService) is a second gate on top
// of these for void-after-fire, discounts over threshold and refunds - it
// never replaces them.
import { SetMetadata } from '@nestjs/common'

export const PERMISSIONS = [
  'take_orders',
  'fire_kitchen',
  'settle_bills',
  'discounts',
  'void_after_fire',
  'refunds',
  'z_report',
  'manage_menu',
  'manage_staff',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  Owner: PERMISSIONS,
  Manager: PERMISSIONS,
  Cashier: ['take_orders', 'fire_kitchen', 'settle_bills', 'discounts'],
  Waiter: ['take_orders', 'fire_kitchen'],
  Kitchen: ['fire_kitchen'],
  Accountant: ['settle_bills', 'z_report'],
}

export function permissionsFor(role: string): readonly Permission[] {
  return Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : []
}

export function roleHasPermission(role: string, permission: Permission): boolean {
  return permissionsFor(role).includes(permission)
}

export const ROUTE_PERMISSION = 'restiq:route-permission'
export type RoutePolicy = Permission | 'any_staff'

// Every non-public /pos and /kitchen handler carries exactly one of these.
// PosAuthGuard refuses a handler with neither, so a new route can't ship
// without someone deciding who may call it.
export const RequirePermission = (permission: Permission) => SetMetadata(ROUTE_PERMISSION, permission)
export const AnyStaff = () => SetMetadata(ROUTE_PERMISSION, 'any_staff' satisfies RoutePolicy)
