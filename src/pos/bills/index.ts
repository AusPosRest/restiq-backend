// Scoped public surface of pos/bills' shared money-path core - NOT the whole
// pos module (that stays src/pos/index.ts, exporting only PosModule).
// guest/bills (qr-self-order/CAP-5, issue #80, AD-18) imports the plain
// functions/types below to create and finalise a real Bill through the exact
// same code the staff path uses, without duplicating bill-creation logic and
// without a NestJS module cycle (see bill-core.ts's top comment for why this
// is a separate, framework-free file rather than the full BillsService).
export {
  BILL_INCLUDE,
  commitFinalize,
  computeSubtotal,
  createBillRecord,
  createTenderRecord,
  isUniqueViolation,
  loadBill,
  TAX_RATE_PLACEHOLDER_PERCENT,
  toBillView,
} from './bill-core'
export type { BillWithTenders, CommitFinalizeParams, CreateBillParams } from './bill-core'
export type { BillView, TenderView } from './bills.dtos'
