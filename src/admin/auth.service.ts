// CAP-1: an invited owner accepts their invite, sets a password, and lands
// with an admin-realm (aud:"admin") session in one call - no extra login step.
// Issue #118 adds the returning-owner counterpart: password login.
import { BadRequestException, ConflictException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService, signAdminToken } from '../platform'
import { clearAttempts, isLockedOut, recordFailedAttempt } from './login-lockout'

export interface AcceptInviteResult {
  token: string
  owner: { id: string; tenantId: string; email: string; firstName: string; lastName: string }
}

export type OwnerSessionResult = AcceptInviteResult

async function setInviteAcceptContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.invite_accept_context', 'invite', true)`
}

// Owner login (#118) needs the same shape of problem as invite acceptance:
// find an OwnerUser by email alone, before any tenant_id is known, which
// means a SELECT across every tenant. Reuses the invite-accept pattern with
// its own dedicated context/policy (`owner_login_read`, migration
// 20260906000000) rather than overloading `app.invite_accept_context`, so
// the two read paths stay independently auditable/revocable.
async function setOwnerLoginContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.owner_login_context', 'login', true)`
}

@Injectable()
export class AdminAuthService {
  // Verified when the email matches no OwnerUser (or matches more than one -
  // see ambiguous_owner below) so every failure path costs one argon2 verify,
  // no owner-existence enumeration via response timing (same reasoning as
  // OpsAuthService.dummyHash).
  private dummyHash?: Promise<string>

  constructor(private readonly registry: RegionRegistryService) {}

  async login(email: string, password: string): Promise<OwnerSessionResult> {
    const normalized = email.trim().toLowerCase()

    if (isLockedOut(normalized)) {
      throw new HttpException({ code: 'locked_out', message: 'Too many incorrect attempts - try again shortly' }, 429)
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const candidates = await plane.$transaction(async (tx) => {
      await setOwnerLoginContext(tx)
      return tx.ownerUser.findMany({ where: { email: normalized } })
    })

    if (candidates.length > 1) {
      // Cross-tenant email collisions are possible (uniqueness is scoped to
      // (tenantId, email)) but ambiguous for a login that only has an email -
      // surfaced distinctly rather than silently picking one.
      throw new ConflictException({ code: 'ambiguous_owner', message: 'This email matches more than one account - contact support' })
    }

    const owner = candidates[0]
    const hash = owner?.passwordHash ?? (await (this.dummyHash ??= argon2.hash('not-a-real-password')))
    const verified = await argon2.verify(hash, password)

    if (!owner || !verified) {
      recordFailedAttempt(normalized)
      // Generic on purpose: never reveal which of email/password was wrong.
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Email or password is incorrect' })
    }
    clearAttempts(normalized)

    const principal: AdminPrincipal = { id: owner.id, tenantId: owner.tenantId, email: owner.email }
    return {
      token: signAdminToken(principal),
      owner: { id: owner.id, tenantId: owner.tenantId, email: owner.email, firstName: owner.firstName, lastName: owner.lastName },
    }
  }

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
