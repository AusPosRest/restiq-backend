// pos/CAP-10 shift & cash management (AD-14). See prisma/schema.prisma's
// Shift/CashMovement comment block for the insert-only/one-open-shift
// invariants this service must uphold; this file is where they're enforced.
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import type { CashMovement, Prisma, Shift } from '../../generated/prisma/client'
import { PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { CloseShiftDto, LogCashMovementDto, OpenShiftDto } from './shifts.dtos'

type Tx = Prisma.TransactionClient

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

export interface CashMovementView {
  id: string
  type: string
  amountMinor: number
  reason: string
  createdByStaffId: string
  createdAt: string
}

export interface ShiftView {
  id: string
  tenantId: string
  outletId: string
  openedByStaffId: string
  floatMinor: number
  openedAt: string
  closedByStaffId: string | null
  closedAt: string | null
  // Present only once close() has run - never computed or returned by any
  // other code path (CAP-10's blind-count rule).
  countedMinor: number | null
  expectedMinor: number | null
  overShortMinor: number | null
  cashMovements: CashMovementView[]
}

const SHIFT_INCLUDE = { cashMovements: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.ShiftInclude

type ShiftWithMovements = Shift & { cashMovements: CashMovement[] }

function toCashMovementView(m: CashMovement): CashMovementView {
  return {
    id: m.id,
    type: m.type,
    amountMinor: Number(m.amountMinor),
    reason: m.reason,
    createdByStaffId: m.createdByStaffId,
    createdAt: m.createdAt.toISOString(),
  }
}

function toShiftView(shift: ShiftWithMovements): ShiftView {
  return {
    id: shift.id,
    tenantId: shift.tenantId,
    outletId: shift.outletId,
    openedByStaffId: shift.openedByStaffId,
    floatMinor: Number(shift.floatMinor),
    openedAt: shift.openedAt.toISOString(),
    closedByStaffId: shift.closedByStaffId,
    closedAt: shift.closedAt?.toISOString() ?? null,
    countedMinor: shift.countedMinor === null ? null : Number(shift.countedMinor),
    expectedMinor: shift.expectedMinor === null ? null : Number(shift.expectedMinor),
    overShortMinor: shift.overShortMinor === null ? null : Number(shift.overShortMinor),
    cashMovements: shift.cashMovements.map(toCashMovementView),
  }
}

async function loadOutlet(tx: Tx, tenantId: string, outletId: string): Promise<void> {
  const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
  if (!outlet || outlet.tenantId !== tenantId) {
    throw new BadRequestException({ code: 'validation_failed', message: 'No such outlet' })
  }
}

async function loadShift(tx: Tx, tenantId: string, shiftId: string): Promise<ShiftWithMovements> {
  const shift = await tx.shift.findUnique({ where: { id: shiftId }, include: SHIFT_INCLUDE })
  if (!shift || shift.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such shift' })
  }
  return shift
}

async function loadOpenShift(tx: Tx, tenantId: string, shiftId: string): Promise<ShiftWithMovements> {
  const shift = await loadShift(tx, tenantId, shiftId)
  if (shift.closedAt) {
    throw new ConflictException({ code: 'shift_already_closed', message: 'This shift is already closed' })
  }
  return shift
}

/** Sum of cash tenders on bills finalised at this outlet since the shift opened - the real cash sales that landed in the till. */
async function computeCashSalesMinor(tx: Tx, tenantId: string, outletId: string, sinceOpenedAt: Date): Promise<bigint> {
  const cashTenders = await tx.tender.findMany({
    where: { tenantId, method: 'cash', bill: { outletId, status: 'finalized', finalizedAt: { gte: sinceOpenedAt } } },
  })
  return cashTenders.reduce((sum, t) => sum + t.amountMinor, 0n)
}

// The pos guard only verifies the JWT signature/audience (issue #44's real
// login isn't wired up yet - see pos-jwt.ts's stub notice); it never touches
// the database. Every mutating action here re-checks that the session's
// staffId is a real, tenant-owned StaffUser before writing anything under
// their name - defense in depth against a forged or stale session claim.
async function assertStaffInTenant(tx: Tx, tenantId: string, staffId: string): Promise<void> {
  const staff = await tx.staffUser.findUnique({ where: { id: staffId } })
  if (!staff || staff.tenantId !== tenantId) {
    throw new UnauthorizedException({ code: 'unauthorized', message: 'This session does not match a known staff member' })
  }
}

@Injectable()
export class ShiftsService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async openShift(staff: PosPrincipal, dto: OpenShiftDto): Promise<ShiftView> {
    const plane = this.plane()
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, staff.tenantId)
        await assertStaffInTenant(tx, staff.tenantId, staff.id)
        await loadOutlet(tx, staff.tenantId, dto.outletId)

        // Pre-check for a clear, immediate error in the common case; the
        // partial unique index (shifts_one_open_per_outlet, see this
        // model's migration) is what actually stops a concurrent race - the
        // catch block below translates that into the same response.
        const alreadyOpen = await tx.shift.findFirst({ where: { outletId: dto.outletId, closedAt: null } })
        if (alreadyOpen) {
          throw new ConflictException({ code: 'shift_already_open', message: 'This outlet already has an open shift' })
        }

        const shift = await tx.shift.create({
          data: {
            id: uuidv7(),
            tenantId: staff.tenantId,
            outletId: dto.outletId,
            openedByStaffId: staff.id,
            floatMinor: BigInt(dto.floatMinor),
          },
          include: SHIFT_INCLUDE,
        })
        return toShiftView(shift)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'shift_already_open', message: 'This outlet already has an open shift' })
      }
      throw error
    }
  }

  async getCurrentShift(staff: PosPrincipal, outletId: string): Promise<ShiftView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const shift = await tx.shift.findFirst({ where: { outletId, closedAt: null }, include: SHIFT_INCLUDE })
      if (!shift) {
        throw new NotFoundException({ code: 'not_found', message: 'No open shift for this outlet' })
      }
      return toShiftView(shift)
    })
  }

  async getShift(staff: PosPrincipal, shiftId: string): Promise<ShiftView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const shift = await loadShift(tx, staff.tenantId, shiftId)
      return toShiftView(shift)
    })
  }

  async logCashMovement(staff: PosPrincipal, shiftId: string, dto: LogCashMovementDto): Promise<ShiftView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await assertStaffInTenant(tx, staff.tenantId, staff.id)
      await loadOpenShift(tx, staff.tenantId, shiftId)

      await tx.cashMovement.create({
        data: {
          id: uuidv7(),
          tenantId: staff.tenantId,
          shiftId,
          type: dto.type,
          amountMinor: BigInt(dto.amountMinor),
          reason: dto.reason,
          createdByStaffId: staff.id,
        },
      })

      const updated = await loadShift(tx, staff.tenantId, shiftId)
      return toShiftView(updated)
    })
  }

  // CAP-10's load-bearing rule: the counted amount is a required input, and
  // expectedMinor/overShortMinor are computed and written in this same call
  // - never before it, never by a separate endpoint. There is no
  // "peek at expected" method anywhere in this service.
  async closeShift(staff: PosPrincipal, shiftId: string, dto: CloseShiftDto): Promise<ShiftView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await assertStaffInTenant(tx, staff.tenantId, staff.id)
      const shift = await loadOpenShift(tx, staff.tenantId, shiftId)

      let paidOutMinor = 0n
      let bankDropMinor = 0n
      for (const movement of shift.cashMovements) {
        if (movement.type === 'paid_out') paidOutMinor += movement.amountMinor
        else bankDropMinor += movement.amountMinor
      }
      // pos/CAP-7 (Bill & Settle) landed Order/Bill/Tender - this fulfils the
      // TODO left here by that story: real cash-tender bill totals now count
      // toward the till, not just float minus paid-outs/bank-drops. Bill/
      // Tender carry no shiftId (only one shift may be open per outlet at a
      // time, so an outlet + "finalized since this shift opened" filter is
      // unambiguous - no new column needed).
      const cashSalesMinor = await computeCashSalesMinor(tx, staff.tenantId, shift.outletId, shift.openedAt)
      const expectedMinor = shift.floatMinor + cashSalesMinor - paidOutMinor - bankDropMinor
      const countedMinor = BigInt(dto.countedMinor)
      const overShortMinor = countedMinor - expectedMinor

      const closed = await tx.shift.update({
        where: { id: shiftId },
        data: {
          closedByStaffId: staff.id,
          closedAt: new Date(),
          countedMinor,
          expectedMinor,
          overShortMinor,
        },
        include: SHIFT_INCLUDE,
      })
      return toShiftView(closed)
    })
  }
}
