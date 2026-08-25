// CAP-8 manager authorisation gate (AD-15): one shared service every gated
// mutation calls into, instead of six reimplementations of the same
// PIN-check-plus-audit-row logic. Bound actions: order void-after-fire and
// comp (pos/CAP-3), bill discount-above-threshold and price override
// (pos/CAP-7), refund (pos/CAP-9), no-sale drawer-open (pos/CAP-10) - see
// MANAGER_GATED_ACTIONS below.
//
// "Manager-capable" - the decision other stories depend on: a StaffUser is
// manager-capable when their Role has isManager = true (see
// prisma/schema.prisma's Role model), NOT a hardcoded role-name check
// against "Manager". Seeded true for 'Owner' and 'Manager' only
// (ops/tenants/tenants.service.ts SYSTEM_ROLES) - a flag on Role, not a
// name convention, so a tenant's set of approving roles can change (e.g. a
// tenant later wants Accountant to approve refunds) without touching this
// service, matching the same "role property, not magic string" posture the
// codebase already uses for isSystem. The alternative (checking
// `role.name === 'Manager'`) was rejected: it's one string comparison
// cheaper today, but it couples authorisation to a display name that
// tenant-admin/CAP-7 already lets an owner rename in principle, and it
// can't express "Owner is also manager-capable" without hardcoding a
// second name.
//
// Design decision - a callable service, not a guard/decorator (the task's
// other option): a Nest guard runs before the route handler and has no way
// to join the caller's own mutation transaction, but AD-6 requires the
// audit row land in the SAME transaction as the mutation it gates. Splitting
// this into authorize() (read-only, runs its own transaction, called
// before the caller's mutation) and recordApproval() (a plain write the
// caller invokes INSIDE their own transaction) composes with that
// requirement directly - a guard/decorator would need an awkward
// side-channel to hand a transaction handle back out to Nest's request
// pipeline, and couldn't be unit-tested without booting HTTP. This also
// means all four future call sites can call it as a normal awaited method,
// no decorator wiring or metadata reflection to get right.
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import type { Prisma } from '../generated/prisma/client'
import { RegionRegistryService } from './region-registry.service'

// The six actions AD-15 names as bound to this gate, in AD-15's own words.
// A union, not a bare string, so a typo at any future call site is a
// compile error, not a silently-mislabelled audit row. This literal also
// becomes the audit_events.action value for the row recordApproval writes.
export const MANAGER_GATED_ACTIONS = [
  'void_after_fire',
  'comp',
  'discount_above_threshold',
  'price_override',
  'refund',
  'no_sale_drawer_open',
] as const
export type ManagerGatedAction = (typeof MANAGER_GATED_ACTIONS)[number]

/**
 * Returned by authorize() on success. Carries tenantId/actionType/reason
 * through from the call that verified them, so recordApproval() doesn't
 * need them re-supplied (and can't drift from what was actually checked).
 */
export interface ManagerApproval {
  approverId: string
  approverName: string
  roleId: string
  roleName: string
  tenantId: string
  actionType: ManagerGatedAction
  reason: string
}

/** The parts of the audit row only the caller knows: who was acting, and when the action happened. */
export interface ManagerGatedActor {
  actorId?: string
  actorEmail: string
  occurredAt: Date
}

// Duplicated on purpose, not imported from admin/menu/tenant-context.ts:
// that helper already exists once per admin submodule that needs it (see
// its own comment) rather than centralized, and platform must not import
// from admin anyway (admin already imports platform - that'd be circular).
async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

@Injectable()
export class ManagerAuthService {
  // Verified against a real hash even when zero manager-capable staff exist
  // for the tenant - same reasoning as OpsAuthService.dummyHash - so
  // failure timing doesn't leak whether the tenant has any managers at all.
  private dummyHash?: Promise<string>

  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /**
   * Verifies a manager PIN plus mandatory reason for a gated action. On
   * success, returns the approver's identity; throws otherwise.
   *
   * outletId is accepted for interface parity with the money-path's
   * outlet-scoped shape (AD-14) and so every call site can pass the same
   * request context uniformly, but StaffUser rows are tenant-scoped, not
   * outlet-scoped, in this schema - SPEC has staff pick an outlet right
   * after login, they aren't assigned to one - so it currently plays no
   * part in finding a candidate approver, and it isn't persisted on the
   * audit row either (audit_events has no outlet column). A caller that
   * needs outlet context in its own trail includes it in its own
   * reason/action string.
   */
  async authorize(
    actionType: ManagerGatedAction,
    tenantId: string,
    outletId: string,
    enteredPin: string,
    reason: string,
  ): Promise<ManagerApproval> {
    void outletId // see doc comment above - accepted, not yet used

    // Cheapest check first: reject a missing reason before touching the
    // database or doing any argon2 work.
    if (!reason.trim()) {
      throw new BadRequestException({ code: 'validation_failed', message: 'A reason is required for manager authorisation' })
    }

    const plane = this.plane()
    const candidates = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      return tx.staffUser.findMany({
        where: { tenantId, pinHash: { not: null }, pinRevokedAt: null, role: { isManager: true } },
        include: { role: { select: { id: true, name: true } } },
      })
    })

    for (const candidate of candidates) {
      // pinHash can't be null here (filtered in the query above) - the
      // field stays nullable because it's shared with StaffUser's
      // unfiltered shape elsewhere.
      if (await argon2.verify(candidate.pinHash as string, enteredPin)) {
        return {
          approverId: candidate.id,
          approverName: candidate.name,
          roleId: candidate.role.id,
          roleName: candidate.role.name,
          tenantId,
          actionType,
          reason,
        }
      }
    }

    // No match - wrong PIN, the PIN belongs to a non-manager, or no
    // manager-capable staff exist at all. One dummy verify keeps the
    // response time the same across all three cases, so a caller can't
    // learn from timing whether this tenant has any managers.
    await argon2.verify(await (this.dummyHash ??= argon2.hash('not-a-real-pin')), enteredPin)
    throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Incorrect manager PIN' })
  }

  /**
   * Writes the audit_events row for a gated action. The caller calls this
   * INSIDE its own mutation transaction (AD-6: same transaction as the
   * mutation) - this service never owns or opens that transaction, only
   * shapes the insert consistently across all four gated call sites.
   */
  async recordApproval(tx: Prisma.TransactionClient, approval: ManagerApproval, actor: ManagerGatedActor): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: approval.tenantId,
        actorId: actor.actorId ?? null,
        actorEmail: actor.actorEmail,
        approverId: approval.approverId,
        approverName: approval.approverName,
        action: approval.actionType,
        reason: approval.reason,
        occurredAt: actor.occurredAt,
      },
    })
  }
}
