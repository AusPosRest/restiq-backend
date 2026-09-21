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
// restiq-backend#160: combos on the POS, QR and kiosk menus and their picks.
export { listMenuCombos, resolveComboSelection } from './menu/combo-menu'
export type { ComboMenuView, ComboSelectionInput, ResolvedComboChild } from './menu/combo-menu'
export { ComboSelectionDto } from './menu/combos.dtos'
export { TaxRegistrationService } from './tax/tax-registration.service'
