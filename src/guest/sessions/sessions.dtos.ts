import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator'
import { NotBlank } from '../../platform'
import type { TableSessionStatus } from '../../generated/prisma/client'

// 4-digit PIN per SPEC CAP-1 - deliberately NOT credential-grade (see
// TableSession.sessionPin's schema comment and AD-17). Same shape as pos
// auth.dtos.ts's PIN_PATTERN, duplicated per module by existing convention.
const PIN_PATTERN = /^\d{4}$/

// SE-19: 8-15 digits, optionally with a leading + and spaces or hyphens
// ("9876543210", "+91 98765 43210", "0412-345-678").
const PHONE_PATTERN = /^\+?\d(?:[\d -]{6,18})\d$/

export class StartSessionDto {
  @IsUUID()
  outletId!: string

  @IsUUID()
  tableId!: string

  @IsString() @NotBlank() @MaxLength(80)
  name!: string

  @IsString() @Matches(PHONE_PATTERN, { message: 'phone must be a phone number' })
  phone!: string
}

export class JoinSessionDto {
  @IsUUID()
  outletId!: string

  @IsUUID()
  tableId!: string

  @Matches(PIN_PATTERN, { message: 'pin must be exactly 4 digits' })
  pin!: string

  @IsString() @NotBlank() @MaxLength(80)
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

// CU-21: with a tableId the check also says whether that table can take a QR
// order right now (reason 'table_busy' when staff already have an order on it).
export class AvailabilityQueryDto {
  @IsOptional() @IsUUID()
  tableId?: string
}

export interface OutletAvailability {
  available: boolean
  reason?: string
}

// CU-22/PE-24: who and where the guest scanned, for the welcome screen -
// public, read before any session exists. Nothing a guest couldn't read off
// the restaurant's own signage.
export interface TableWelcomeView {
  restaurantName: string
  outletName: string
  tableLabel: string
}
