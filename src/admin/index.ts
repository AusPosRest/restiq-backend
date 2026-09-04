// Public surface of the admin module - cross-module imports go through here.
export { AdminModule } from './admin.module'
// pos/CAP-1 (AD-13) reuses this verbatim rather than reimplementing PIN
// status logic - the same argon2/pinHash/pinRevokedAt convention Tenant
// Admin's PIN issue/revoke already established.
export { pinStatus } from './staff/staff.service'
export type { PinStatus } from './staff/staff.service'
// pos/CAP-3 reuses this verbatim to snapshot an order line's price at
// add-time against the real, already-shipped item_prices resolution rules -
// no second price-picking implementation.
export { resolveCurrentPrice } from './menu/pricing'
export { TaxRegistrationService } from './tax/tax-registration.service'
