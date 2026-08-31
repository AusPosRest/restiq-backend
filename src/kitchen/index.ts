// Public surface of the kitchen module (AD-2) - cross-module imports (pos/
// orders, pos/order-lines) go through here, never a deep import.
export { KitchenModule } from './kitchen.module'
export { KitchenTicketsService } from './tickets.service'
export type { BumpedTicketView, Tx as KitchenTx } from './tickets.service'
export * from './tickets.dtos'
