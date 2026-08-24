// CAP-1: an invited owner accepts their invite, sets a password, and lands
// with an admin-realm (aud:"admin") session in one call - no extra login step.
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService, signAdminToken } from '../platform'

export interface AcceptInviteResult {
  token: string
  owner: { id: string; tenantId: string; email: string; firstName: string; lastName: string }
}

async function setInviteAcceptContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.invite_accept_context', 'invite', true)`
}

@Injectable()
export class AdminAuthService {
  constructor(private readonly registry: RegionRegistryService) {}

  async acceptInvite(token: string, password: string): Promise<AcceptInviteResult> {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    // CPU-bound - hashed outside the transaction so the DB connection isn't
    // held for the duration of the argon2 work (same reasoning as the ops
    // login dummy-hash comment elsewhere).
    const passwordHash = await argon2.hash(password)
    const plane = this.registry.planeFor(this.registry.homeRegion())

    const result = await plane.$transaction(async (tx) => {
      await setInviteAcceptContext(tx)
      const invite = await tx.ownerInvite.findUnique({ where: { tokenHash } })
      if (!invite) {
        throw new BadRequestException({ code: 'invite_invalid', message: 'This invite link is not valid' })
      }
      if (invite.usedAt) {
        throw new ConflictException({ code: 'invite_already_used', message: 'This invite has already been used' })
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException({ code: 'invite_expired', message: 'This invite has expired' })
      }

      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${invite.tenantId}, true)`

      // Atomic consume: closes the race between two concurrent accepts of the
      // same token (same pattern as enrolment-code consumption).
      const consumed = await tx.ownerInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } })
      if (consumed.count === 0) {
        throw new ConflictException({ code: 'invite_already_used', message: 'This invite has already been used' })
      }

      const owner = await tx.ownerUser.upsert({
        where: { tenantId_email: { tenantId: invite.tenantId, email: invite.email } },
        create: { tenantId: invite.tenantId, email: invite.email, firstName: invite.firstName, lastName: invite.lastName, passwordHash },
        update: { passwordHash, firstName: invite.firstName, lastName: invite.lastName },
      })

      // Seeds the checklist so GET /admin/v1/checklist has a row from the
      // owner's very first request (CAP-2).
      await tx.checklistProgress.upsert({
        where: { tenantId: invite.tenantId },
        create: { tenantId: invite.tenantId },
        update: {},
      })

      await tx.auditEvent.create({
        data: {
          tenantId: invite.tenantId,
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'owner.invite_accepted',
          reason: 'Owner accepted invite and set account credentials',
          occurredAt: new Date(),
        },
      })

      return owner
    })

    const principal: AdminPrincipal = { id: result.id, tenantId: result.tenantId, email: result.email }
    return {
      token: signAdminToken(principal),
      owner: { id: result.id, tenantId: result.tenantId, email: result.email, firstName: result.firstName, lastName: result.lastName },
    }
  }
}
