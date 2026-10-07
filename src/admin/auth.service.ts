// CAP-1: an invited owner accepts their invite, sets a password, and lands
// with an admin-realm (aud:"admin") session in one call - no extra login step.
// Issue #118 adds the returning-owner counterpart: password login.
import { BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import { AdminPrincipal, AttemptLimiter, AttemptRule, MailService, RegionRegistryService, signAdminToken } from '../platform'

export interface InviteDetails {
  restaurantName: string
  email: string
  firstName: string
}

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

// restiq-backend#171: per account (5 per 15 minutes) and per client IP (30
// per 15 minutes, so one address can't walk through many accounts), shared
// across instances - see platform/attempt-limiter.ts.
function ownerLoginRules(email: string, ip: string): AttemptRule[] {
  return [
    { key: `owner-login:email:${email}`, max: 5, windowSeconds: 15 * 60 },
    { key: `owner-login:ip:${ip}`, max: 30, windowSeconds: 15 * 60 },
  ]
}

// Password reset (#181): asking and using the link both start with no tenant known (an email, or a
// token), so each runs under its own narrow row-level-security context - see reset_flow.
async function setPasswordResetContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.password_reset_context', 'reset', true)`
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

function resetRequestRules(email: string, ip: string): AttemptRule[] {
  return [
    { key: `owner-reset:email:${email}`, max: 3, windowSeconds: 15 * 60 },
    { key: `owner-reset:ip:${ip}`, max: 10, windowSeconds: 15 * 60 },
  ]
}

function resetEmail(link: string): { subject: string; text: string; html: string } {
  return {
    subject: 'Reset your RESTIQ password',
    text: `Someone asked to reset the password for your RESTIQ owner account.\n\nOpen this link within one hour to choose a new password:\n${link}\n\nIf this was not you, ignore this email - your password stays as it is.`,
    html: `<p>Someone asked to reset the password for your RESTIQ owner account.</p><p><a href="${link}">Choose a new password</a> (the link works for one hour).</p><p>If this was not you, ignore this email - your password stays as it is.</p>`,
  }
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name)

  // Verified when the email matches no OwnerUser (or matches more than one -
  // see ambiguous_owner below) so every failure path costs one argon2 verify,
  // no owner-existence enumeration via response timing (same reasoning as
  // OpsAuthService.dummyHash).
  private dummyHash?: Promise<string>

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly limiter: AttemptLimiter,
    private readonly mail: MailService,
  ) {}

  async login(email: string, password: string, ip: string): Promise<OwnerSessionResult> {
    const normalized = email.trim().toLowerCase()
    const rules = ownerLoginRules(normalized, ip)
    await this.limiter.consume(rules)

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
      // Generic on purpose: never reveal which of email/password was wrong.
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Email or password is incorrect' })
    }
    await this.limiter.refund(rules)

    const principal: AdminPrincipal = { id: owner.id, tenantId: owner.tenantId, email: owner.email, sessionVersion: owner.sessionVersion }
    return {
      token: signAdminToken(principal),
      owner: { id: owner.id, tenantId: owner.tenantId, email: owner.email, firstName: owner.firstName, lastName: owner.lastName },
    }
  }

  /**
   * Always answers the same, whether or not the email belongs to an owner, so it cannot be used to find
   * accounts. The email goes out in the background for the same reason (no timing difference).
   */
  async forgotPassword(email: string, ip: string): Promise<{ accepted: true }> {
    const normalized = email.trim().toLowerCase()
    await this.limiter.consume(resetRequestRules(normalized, ip))

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const links = await plane.$transaction(async (tx) => {
      await setOwnerLoginContext(tx)
      await setPasswordResetContext(tx)
      const owners = await tx.ownerUser.findMany({ where: { email: normalized } })
      const issued: string[] = []
      for (const owner of owners) {
        // A new request ends any link still open for this owner.
        await tx.ownerPasswordReset.updateMany({ where: { ownerId: owner.id, usedAt: null }, data: { usedAt: new Date() } })
        const raw = `rst_${randomBytes(32).toString('hex')}`
        await tx.ownerPasswordReset.create({
          data: { tenantId: owner.tenantId, ownerId: owner.id, tokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
        })
        issued.push(`${(process.env.ADMIN_APP_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:3100').replace(/\/$/, '')}/admin/reset-password?token=${raw}`)
      }
      return issued
    })
    for (const link of links) {
      void this.mail.send({ to: normalized, ...resetEmail(link) }).catch((error: unknown) => this.logger.error(`Password reset email failed: ${String(error)}`))
    }
    return { accepted: true }
  }

  /** Sets the new password, ends every session the owner already has, and uses the link up. */
  async resetPassword(token: string, password: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const passwordHash = await argon2.hash(password)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setPasswordResetContext(tx)
      const reset = await tx.ownerPasswordReset.findUnique({ where: { tokenHash } })
      if (!reset || reset.usedAt) throw new BadRequestException({ code: 'reset_invalid', message: 'This reset link is not valid' })
      if (reset.expiresAt.getTime() <= Date.now()) throw new BadRequestException({ code: 'reset_expired', message: 'This reset link has expired' })

      // Atomic use: two requests with the same link cannot both succeed.
      const used = await tx.ownerPasswordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: new Date() } })
      if (used.count === 0) throw new BadRequestException({ code: 'reset_invalid', message: 'This reset link is not valid' })
      await tx.ownerPasswordReset.updateMany({ where: { ownerId: reset.ownerId, usedAt: null }, data: { usedAt: new Date() } })

      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${reset.tenantId}, true)`
      const owner = await tx.ownerUser.update({ where: { id: reset.ownerId }, data: { passwordHash, sessionVersion: { increment: 1 } } })
      await tx.auditEvent.create({
        data: {
          tenantId: reset.tenantId,
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'owner.password_reset',
          reason: 'Owner reset their password from an emailed link; every earlier session was ended',
          occurredAt: new Date(),
        },
      })
    })
  }

  /** Who an unused, unexpired invite is for (issue #193) - reads only, consumes nothing. */
  async inviteDetails(token: string): Promise<InviteDetails> {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setInviteAcceptContext(tx)
      const invite = await tx.ownerInvite.findUnique({ where: { tokenHash } })
      if (!invite) throw new BadRequestException({ code: 'invite_invalid', message: 'This invite link is not valid' })
      if (invite.usedAt) throw new ConflictException({ code: 'invite_already_used', message: 'This invite has already been used' })
      if (invite.expiresAt.getTime() <= Date.now()) throw new BadRequestException({ code: 'invite_expired', message: 'This invite has expired' })
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${invite.tenantId}, true)`
      const tenant = await tx.tenant.findUnique({ where: { id: invite.tenantId }, select: { name: true } })
      return { restaurantName: tenant?.name ?? '', email: invite.email, firstName: invite.firstName }
    })
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

    const principal: AdminPrincipal = { id: result.id, tenantId: result.tenantId, email: result.email, sessionVersion: result.sessionVersion }
    return {
      token: signAdminToken(principal),
      owner: { id: result.id, tenantId: result.tenantId, email: result.email, firstName: result.firstName, lastName: result.lastName },
    }
  }
}
