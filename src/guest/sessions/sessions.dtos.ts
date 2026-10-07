import { IsNotEmpty, IsString, IsUUID, Matches } from 'class-validator'
import type { TableSessionStatus } from '../../generated/prisma/client'

// 4-digit PIN per SPEC CAP-1 - deliberately NOT credential-grade (see
// TableSession.sessionPin's schema comment and AD-17). Same shape as pos
// auth.dtos.ts's PIN_PATTERN, duplicated per module by existing convention.
const PIN_PATTERN = /^\d{4}$/

export class StartSessionDto {
  @IsUUID()
  outletId!: string

  @IsUUID()
  tableId!: string

  @IsString() @IsNotEmpty()
  name!: string

  @IsString() @IsNotEmpty()
  phone!: string
}

export class JoinSessionDto {
  @IsUUID()
  outletId!: string

  @IsUUID()
  tableId!: string

  @Matches(PIN_PATTERN, { message: 'pin must be exactly 4 digits' })
  pin!: string

  @IsString() @IsNotEmpty()
  name!: string
}

// Issue #138: a kiosk tab starts a table-less session bound to its enrolled
// device - no name, phone or PIN; the device row is the identity.
export class StartKioskSessionDto {
  @IsUUID()
  outletId!: string

  @IsUUID()
  deviceId!: string
}

export interface GuestSummary {
  id: string
  name: string
  joinedAt: string
}

export interface TableSummary {
  id: string
  label: string
}

export interface TableSessionView {
  sessionId: string
  status: TableSessionStatus
  // null for a kiosk session (issue #138).
  table: TableSummary | null
  outletId: string
  guests: GuestSummary[]
  createdAt: string
  expiresAt: string
  closedAt: string | null
}

export interface SessionStartResult {
  token: string
  pin: string
  session: TableSessionView
}

export interface KioskSessionStartResult {
  token: string
  session: TableSessionView
}

export interface SessionJoinResult {
  token: string
  session: TableSessionView
}

export interface OutletAvailability {
  available: boolean
  reason?: string
}
