// Public surface of the guest module - cross-module imports go through here.
export { GuestModule } from './guest.module'
// pos/tables/tables.controller.ts reuses this for the staff-side close - no
// second close-a-table-session implementation.
export { GuestSessionsService } from './sessions/sessions.service'
