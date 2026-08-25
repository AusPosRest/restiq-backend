import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator'
import type { OrderStatus } from '../../generated/prisma/client'

const ORDER_STATUSES = ['open', 'sent', 'closed'] as const

export class UpdateOrderStatusDto {
  @IsEnum(ORDER_STATUSES)
  status!: OrderStatus
}

// reason is optional - per SPEC (stories.yaml story 3), transfer isn't one of
// CAP-8's six manager-gated actions, so no PIN/reason requirement applies.
// It's still audited (AD-6) with a fixed placeholder when omitted, since
// audit_events.reason is NOT NULL.
export class TransferOrderDto {
  @IsUUID()
  newOwnerStaffId!: string

  @IsOptional() @IsString() @MinLength(1)
  reason?: string
}

export interface OrderView {
  id: string
  tenantId: string
  outletId: string
  tableId: string | null
  ownerId: string
  status: OrderStatus
  createdAt: string
  updatedAt: string
}

export type TableMapStatus = 'occupied' | 'empty'

export interface TableMapEntry {
  tableId: string
  floorId: string
  label: string
  seatCapacity: number
  // TODO(pos/CAP-7 Bill and settle): SPEC's third state, "needs-bill", is
  // defined by whether a Bill has been requested for the table's order - the
  // Bill model doesn't exist yet (AD-14 introduces it in a later story). Once
  // it does, this union grows a third member and getTableMap() reads Bill
  // state the same way it reads Order state below.
  status: TableMapStatus
  orderId: string | null
  ownerId: string | null
}
