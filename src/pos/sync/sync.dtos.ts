// Offline sync push shapes (restiq-backend#185). The op payloads reuse the
// online endpoints' DTOs; the classes here only add what an offline op needs
// on top: the ids the hub made and, for a line, the price it charged.
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator'
import { FinalizeBillDto } from '../bills/bills.dtos'
import { AddOrderLineDto, TransferOrderDto } from '../orders/orders.dtos'
import { CloseShiftDto, LogCashMovementDto, OpenShiftDto } from '../shifts/shifts.dtos'

export const SYNC_BATCH_MAX = 200

export class SyncOpDto {
  @IsUUID()
  opId!: string

  @IsInt() @Min(1)
  seq!: number

  @IsString()
  type!: string

  @IsISO8601()
  at!: string

  @IsUUID()
  actorStaffId!: string

  @IsObject()
  payload!: Record<string, unknown>
}

// restiq-backend#301 (B4, D-4): a hub's LAN base URL - http(s), a private IPv4
// (10/8, 172.16/12, 192.168/16) or *.local host, and an explicit port.
const LAN_URL = /^https?:\/\/([a-z0-9.-]+):(\d{1,5})\/?$/i
const LOCAL_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+local$/i

// ponytail: plain regex, not new URL() - URL rewrites "010" as octal and throws on "08".
export function isLanUrl(url: string): boolean {
  const match = LAN_URL.exec(url)
  if (!match) return false
  const [, host, port] = match
  if (Number(port) < 1 || Number(port) > 65535) return false
  if (LOCAL_HOST.test(host)) return true
  const octets = host.split('.')
  if (octets.length !== 4 || !octets.every((o) => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) return false
  const [a, b] = octets.map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export class HubAddressDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsString({ each: true }) @MaxLength(100, { each: true })
  urls!: string[]
}

export class SyncPushDto {
  @IsUUID()
  batchId!: string

  // No ArrayMaxSize: an oversize batch is answered 413 batch_too_large by the
  // handler, as the contract says, not a generic 400.
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SyncOpDto)
  ops!: SyncOpDto[]
}

const MINOR = /^\d{1,15}$/

export class SyncOrderCreatePayload {
  @IsUUID()
  orderId!: string

  // Table order when set; counter order (with the hub's token) when not.
  @IsOptional() @IsUUID()
  tableId?: string

  @IsOptional() @IsInt() @Min(1)
  tokenNumber?: number
}

export class SyncLineAddPayload extends AddOrderLineDto {
  @IsUUID()
  orderId!: string

  @IsUUID()
  lineId!: string

  // Money as a decimal string of minor units (bigint-safe in JSON).
  @Matches(MINOR)
  unitPriceMinor!: string

  // modifierId -> price charged, for every id in modifierIds.
  @IsOptional() @IsObject()
  modifierPriceMinor?: Record<string, string>
}

export class SyncLineRefPayload {
  @IsUUID()
  orderId!: string

  @IsUUID()
  lineId!: string
}

export class SyncOrderRefPayload {
  @IsUUID()
  orderId!: string
}

export class SyncBillCreatePayload {
  @IsUUID()
  orderId!: string

  @IsUUID()
  billId!: string
}

export class SyncBillFinalizePayload extends FinalizeBillDto {
  @IsUUID()
  billId!: string

  // One id per entry in tenders, same order.
  @IsArray() @IsUUID('all', { each: true })
  tenderIds!: string[]
}

// restiq-backend#297 (B5a): a combo as the hub wrote it - the lines and the
// prices on them are the sale; the cloud does not re-pick the slots.
export class SyncComboChildPayload {
  @IsUUID()
  lineId!: string

  @IsUUID()
  itemId!: string

  @IsOptional() @IsUUID()
  variantId?: string

  // For the whole child line, as on the hub's OrderLineView.
  @IsInt() @Min(1)
  quantity!: number

  @Matches(MINOR)
  unitPriceMinor!: string

  // modifierId -> price charged (decimal string of minor units).
  @IsOptional() @IsObject()
  modifierPriceMinor?: Record<string, string>
}

export class SyncComboAddPayload {
  @IsUUID()
  orderId!: string

  /** The combo's parent line. */
  @IsUUID()
  lineId!: string

  @IsUUID()
  comboId!: string

  @IsInt() @Min(1) @Max(999)
  quantity!: number

  @Matches(MINOR)
  unitPriceMinor!: string

  @IsOptional() @IsInt() @Min(1)
  seatNumber?: number

  @IsArray() @ValidateNested({ each: true }) @Type(() => SyncComboChildPayload)
  children!: SyncComboChildPayload[]
}

// The manager approved on the hub with their PIN; only who it was travels.
export class SyncLineVoidPayload extends SyncLineRefPayload {
  @IsString() @MinLength(1) @MaxLength(200)
  reason!: string

  @IsUUID()
  approvedByStaffId!: string
}

export class SyncOrderTransferPayload extends TransferOrderDto {
  @IsUUID()
  orderId!: string
}

// restiq-backend#297 (B5b).
export class SyncShiftOpenPayload extends OpenShiftDto {
  @IsUUID()
  shiftId!: string
}

export class SyncCashMovementPayload extends LogCashMovementDto {
  @IsUUID()
  shiftId!: string

  @IsUUID()
  movementId!: string
}

export class SyncShiftClosePayload extends CloseShiftDto {
  @IsUUID()
  shiftId!: string
}

export class SyncClockPayload {
  @IsUUID()
  clockEventId!: string
}

// The hub cannot know the cloud's ticket ids, so a bump or recall names the
// order and station (null = unrouted) instead.
export class SyncTicketPayload {
  @IsUUID()
  orderId!: string

  @ValidateIf((o: SyncTicketPayload) => o.stationId !== null) @IsUUID()
  stationId!: string | null
}

export interface SyncOpResult {
  opId: string
  status: 'accepted' | 'duplicate' | 'rejected' | 'deferred'
  code?: string
  message?: string
}
