// Scoped public surface of pos/payments' framework-free intent core - the
// pos/bills barrel's twin (see ../bills/index.ts). guest/bills' kiosk card
// payment (issue #144) confirms through the exact same confirmIntent the
// POS card terminal uses, so no second electronic-tender path exists.
export { confirmIntent } from './intent-core'
