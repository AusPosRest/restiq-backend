// CAP-11 read-only attendance view. See attendance.service.ts for how
// "clocked in" is derived from story 1's real ClockEvent rows.
export interface AttendanceStaffEntry {
  staffId: string
  name: string
  clockedInAt: string
}

// This prototype has no real ESC/POS printer or peripheral hardware
// integration (SPEC.md Constraints - "no real ESC/POS printer or peripheral
// hardware integration"). `status` is a hardcoded placeholder, never a live
// device check, and `mocked: true` keeps that honest for any consumer of
// this response - the same "never dress up fake data as real" discipline as
// the owner dashboard's hasData/message convention
// (admin/dashboard/dashboard.service.ts).
export interface MockedPrinterStatus {
  status: 'connected'
  mocked: true
}

export interface AttendanceView {
  outletId: string
  asOf: string
  staff: AttendanceStaffEntry[]
  printerStatus: MockedPrinterStatus
}
