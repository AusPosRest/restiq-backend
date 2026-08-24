// CAP-7 staff & roles. A staff user is POS-facing (PIN sign-in), distinct
// from the admin console's OwnerUser the same way OperatorUser/OwnerUser are
// already kept apart. Role assignment is restricted to the six seeded
// system roles Platform Console creates per tenant on provisioning
// (tenants.service.ts SYSTEM_ROLES) - never free-text, so every roleId is
// checked against this tenant's own Role rows before it's used (400 if it
// doesn't belong here or isn't a seeded system role).
//
// Creating a staff record or renaming one is a routine content edit (SPEC
// constraint - same posture as adding a menu category) and isn't audited.
// Changing a staff member's role IS security-relevant per SPEC's Constraints
// (named alongside PIN revoke and price change) - it requires a reason and
// writes an audit_events row, same as issuing/revoking a PIN.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { randomInt } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { CreateStaffDto, UpdateStaffDto } from './staff.dtos'

const PIN_LENGTH = 4

export interface RoleView {
  id: string
  name: string
  isSystem: boolean
}

export type PinStatus = 'none' | 'active' | 'revoked'

export interface StaffView {
  id: string
  tenantId: string
  name: string
  email: string | null
  roleId: string
  roleName: string
  pinStatus: PinStatus
  createdAt: string
  updatedAt: string
}

export interface StaffListResult {
  staff: StaffView[]
}

interface StaffWithRole {
  id: string
  tenantId: string
  name: string
  email: string | null
  roleId: string
  pinHash: string | null
  pinRevokedAt: Date | null
  createdAt: Date
  updatedAt: Date
  role: { name: string }
}

// Exported for reuse by CAP-9's staff-roster export (reports.service.ts) -
// the same derivation, not a second copy of the pin/revoked logic.
export function pinStatus(row: Pick<StaffWithRole, 'pinHash' | 'pinRevokedAt'>): PinStatus {
  if (!row.pinHash) return 'none'
  return row.pinRevokedAt ? 'revoked' : 'active'
}

function toStaffView(row: StaffWithRole): StaffView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    email: row.email,
    roleId: row.roleId,
    roleName: row.role.name,
    pinStatus: pinStatus(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function generatePin(): string {
  return randomInt(0, 10 ** PIN_LENGTH).toString().padStart(PIN_LENGTH, '0')
}

const STAFF_INCLUDE = { role: { select: { name: true } } } satisfies Prisma.StaffUserInclude

@Injectable()
export class StaffService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async listRoles(tenantId: string): Promise<RoleView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const roles = await tx.role.findMany({ where: { tenantId }, orderBy: { name: 'asc' } })
      return roles.map((role) => ({ id: role.id, name: role.name, isSystem: role.isSystem }))
    })
  }

  async list(owner: AdminPrincipal): Promise<StaffListResult> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const rows = await tx.staffUser.findMany({
        where: { tenantId: owner.tenantId },
        include: STAFF_INCLUDE,
        orderBy: { createdAt: 'asc' },
      })
      return { staff: rows.map(toStaffView) }
    })
  }

  private async assertSeededRole(tx: Prisma.TransactionClient, tenantId: string, roleId: string): Promise<void> {
    const role = await tx.role.findUnique({ where: { id: roleId } })
    if (!role || role.tenantId !== tenantId || !role.isSystem) {
      throw new BadRequestException({ code: 'validation_failed', message: "roleId must be one of this tenant's seeded system roles" })
    }
  }

  private async findOwnedStaff(tx: Prisma.TransactionClient, tenantId: string, staffId: string): Promise<StaffWithRole> {
    const staff = await tx.staffUser.findUnique({ where: { id: staffId }, include: STAFF_INCLUDE })
    if (!staff || staff.tenantId !== tenantId) {
      throw new NotFoundException({ code: 'not_found', message: 'No such staff member' })
    }
    return staff
  }

  async create(owner: AdminPrincipal, dto: CreateStaffDto): Promise<StaffView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await this.assertSeededRole(tx, owner.tenantId, dto.roleId)

      const isFirstStaffForTenant = (await tx.staffUser.count({ where: { tenantId: owner.tenantId } })) === 0

      const created = await tx.staffUser.create({
        data: { id: uuidv7(), tenantId: owner.tenantId, roleId: dto.roleId, name: dto.name.trim(), email: dto.email },
        include: STAFF_INCLUDE,
      })

      // tenant-admin/CAP-7: same pattern as CAP-6 devices - the go-live
      // checklist's 'staff' step is flipped directly, in the same
      // transaction as the row it reports on, rather than a second round
      // trip through ChecklistService.
      if (isFirstStaffForTenant) {
        await tx.checklistProgress.upsert({
          where: { tenantId: owner.tenantId },
          create: { tenantId: owner.tenantId, staffAt: created.createdAt },
          update: { staffAt: created.createdAt },
        })
      }

      return toStaffView(created)
    })
  }

  async update(owner: AdminPrincipal, staffId: string, dto: UpdateStaffDto): Promise<StaffView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await this.findOwnedStaff(tx, owner.tenantId, staffId)
      const roleChanging = dto.roleId !== undefined && dto.roleId !== existing.roleId
      if (roleChanging) {
        await this.assertSeededRole(tx, owner.tenantId, dto.roleId as string)
        if (!dto.reason) {
          throw new BadRequestException({ code: 'validation_failed', message: 'reason is required when changing a role' })
        }
      }

      const now = new Date()
      const updated = await tx.staffUser.update({
        where: { id: staffId },
        data: { name: dto.name?.trim(), roleId: dto.roleId },
        include: STAFF_INCLUDE,
      })

      // AD-6: role change is named alongside PIN revoke and price change in
      // SPEC's Constraints as security-relevant - audited the same way,
      // unlike the routine rename-only path.
      if (roleChanging) {
        await tx.auditEvent.create({
          data: { tenantId: owner.tenantId, actorId: owner.id, actorEmail: owner.email, action: 'staff.role_changed', reason: dto.reason as string, occurredAt: now },
        })
      }

      return toStaffView(updated)
    })
  }

  async issuePin(owner: AdminPrincipal, staffId: string): Promise<{ pin: string }> {
    const pin = generatePin()
    // CPU-bound - hashed outside the transaction so the DB connection isn't
    // held for the duration of the argon2 work (same reasoning as
    // AdminAuthService.acceptInvite).
    const pinHash = await argon2.hash(pin)

    const plane = this.plane()
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await this.findOwnedStaff(tx, owner.tenantId, staffId)
      // Re-issuing always supersedes any prior PIN, revoked or not - a fresh
      // PIN is unconditionally active from this point.
      await tx.staffUser.update({ where: { id: staffId }, data: { pinHash, pinIssuedAt: new Date(), pinRevokedAt: null } })
    })

    return { pin }
  }

  async revokePin(owner: AdminPrincipal, staffId: string, reason: string): Promise<StaffView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const staff = await this.findOwnedStaff(tx, owner.tenantId, staffId)
      if (!staff.pinHash) throw new ConflictException({ code: 'conflict', message: 'This staff member has no PIN to revoke' })
      if (staff.pinRevokedAt) throw new ConflictException({ code: 'conflict', message: 'This PIN is already revoked' })

      const now = new Date()
      const updated = await tx.staffUser.update({ where: { id: staffId }, data: { pinRevokedAt: now }, include: STAFF_INCLUDE })

      // AD-6: PIN revoke is destructive and security-relevant, so it carries
      // an audited reason in the same transaction as the mutation - unlike
      // the routine name/role edit in update() above.
      await tx.auditEvent.create({
        data: { tenantId: owner.tenantId, actorId: owner.id, actorEmail: owner.email, action: 'staff.pin_revoked', reason, occurredAt: now },
      })

      return toStaffView(updated)
    })
  }
}
