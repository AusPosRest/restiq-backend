// pos/CAP-1 (AD-13): PIN login for a shared device. StaffUser has no
// outletId column (it's tenant-wide - a staff member can work any outlet),
// so this is a two-step flow: verify the PIN against this tenant's active
// StaffUser rows, then either finalise immediately (single-outlet tenant) or
// hand back a short-lived pending token plus the outlet list for the staff
// member to pick from.
import { BadRequestException, ConflictException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { pinStatus } from '../../admin'
import { PosPrincipal, RegionRegistryService, signPosPendingToken, signPosToken, verifyPosPendingToken } from '../../platform'
import type { Outlet, StaffUser } from '../../generated/prisma/client'
import { recordClockInIfNeeded } from '../clock/clock.util'
import { setTenantContext } from '../tenant-context'
import { OutletSummary, PosLoginDto, PosLoginResult, SelectOutletDto, StaffSummary } from './auth.dtos'
import { clearAttempts, isLockedOut, recordFailedAttempt } from './lockout'

function toStaffSummary(staff: StaffUser): StaffSummary {
  return { id: staff.id, name: staff.name }
}

function toOutletSummary(outlet: Outlet): OutletSummary {
  return { id: outlet.id, name: outlet.name }
}

@Injectable()
export class PosAuthService {
  // Verified when there's no PIN match, so both "wrong PIN" and "no staff at
  // all for this tenant" cost one argon2 verify - no tenant/staff enumeration
  // via response timing (same reasoning as OpsAuthService.dummyHash).
  private dummyHash?: Promise<string>

  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async login(dto: PosLoginDto): Promise<PosLoginResult> {
    const { tenantId, pin } = dto

    if (isLockedOut(tenantId, pin)) {
      throw new HttpException({ code: 'locked_out', message: 'Too many incorrect attempts - try again shortly' }, 429)
    }

    const staff = await this.findStaffByPin(tenantId, pin)
    if (!staff) {
      recordFailedAttempt(tenantId, pin)
      throw new UnauthorizedException({ code: 'invalid_pin', message: 'Incorrect tenant or PIN' })
    }
    clearAttempts(tenantId, pin)

    const outlets = await this.listOutlets(tenantId)
    if (outlets.length === 0) {
      throw new ConflictException({ code: 'no_outlets', message: 'This tenant has no outlets configured yet' })
    }

    if (outlets.length > 1) {
      return {
        status: 'select_outlet',
        pendingToken: signPosPendingToken({ id: staff.id, tenantId }),
        staff: toStaffSummary(staff),
        outlets: outlets.map(toOutletSummary),
      }
    }

    return this.finalize(staff, outlets[0])
  }

  async selectOutlet(dto: SelectOutletDto): Promise<PosLoginResult> {
    const pending = verifyPosPendingToken(dto.pendingToken)
    if (!pending) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'This selection has expired - log in again' })
    }

    const plane = this.plane()
    const { staff, outlet } = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, pending.tenantId)
      const staffRow = await tx.staffUser.findUnique({ where: { id: pending.id } })
      if (!staffRow || staffRow.tenantId !== pending.tenantId) {
        throw new UnauthorizedException({ code: 'unauthorized', message: 'This selection has expired - log in again' })
      }
      const outletRow = await tx.outlet.findUnique({ where: { id: dto.outletId } })
      if (!outletRow || outletRow.tenantId !== pending.tenantId || outletRow.deletedAt) {
        throw new BadRequestException({ code: 'invalid_outlet', message: "Select one of this tenant's outlets" })
      }
      return { staff: staffRow, outlet: outletRow }
    })

    return this.finalize(staff, outlet)
  }

  private async findStaffByPin(tenantId: string, pin: string): Promise<StaffUser | null> {
    const plane = this.plane()
    const candidates = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      return tx.staffUser.findMany({ where: { tenantId, pinHash: { not: null } } })
    })

    for (const candidate of candidates) {
      if (pinStatus(candidate) !== 'active') continue
      const hash = candidate.pinHash
      if (!hash) continue
      if (await argon2.verify(hash, pin)) return candidate
    }

    // No match (including zero candidates) - still pay the argon2 cost.
    const hash = await (this.dummyHash ??= argon2.hash('not-a-real-pin'))
    await argon2.verify(hash, pin)
    return null
  }

  private async listOutlets(tenantId: string): Promise<Outlet[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      return tx.outlet.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
    })
  }

  private async finalize(staff: StaffUser, outlet: Outlet): Promise<PosLoginResult> {
    const plane = this.plane()
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await recordClockInIfNeeded(tx, { tenantId: staff.tenantId, staffId: staff.id, outletId: outlet.id, timezone: outlet.timezone })
    })

    const principal: PosPrincipal = { id: staff.id, tenantId: staff.tenantId, outletId: outlet.id, name: staff.name }
    return {
      status: 'authenticated',
      token: signPosToken(principal),
      staff: toStaffSummary(staff),
      outlet: toOutletSummary(outlet),
    }
  }
}
