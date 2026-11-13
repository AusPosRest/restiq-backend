// Offline sync push shapes (restiq-backend#185). The op payloads reuse the
// online endpoints' DTOs; the classes here only add what an offline op needs
// on top: the ids the hub made and, for a line, the price it charged.
import { Type } from 'class-transformer'
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator'
import { FinalizeBillDto } from '../bills/bills.dtos'
import { AddOrderLineDto } from '../orders/orders.dtos'

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

export interface SyncOpResult {
  opId: string
  status: 'accepted' | 'duplicate' | 'rejected' | 'deferred'
  code?: string
  message?: string
}
