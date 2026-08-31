// CAP-8 manager authorisation gate (AD-15), tested directly against the
// service - no caller exists in this codebase yet (this story wires the
// gate itself; stories 4/8/10/2 wire callers into it later, per
// stories.yaml). Proves the story's success criteria: a valid manager PIN
// plus a valid reason approves with the correct approver identity; a wrong
// PIN is rejected; a missing reason is rejected before the PIN is ever
// checked (cheapest-check-first); and a non-manager StaffUser's correct PIN
// is rejected - proving isManager, not merely "has a PIN", gates approval.
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { ManagerAuthService, PlatformModule, uuidv7 } from '../src/platform'

// Full table graph, not just this story's own tables: the e2e suite shares
// one test database across every spec file (fileParallelism: false, see
// vitest.e2e.config.ts), so this wipe must clear anything an earlier file
// could have left behind, the same list staff-roles.e2e-spec.ts and
// reports-catalogue.e2e-spec.ts already use.
async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff;
  // wiped first for the same reason invoice/subscription is below.
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.appliedOp.deleteMany()
  await prisma.syncDeadLetter.deleteMany()
  await prisma.device.deleteMany()
  await prisma.enrolmentCode.deleteMany()
  await prisma.menuImportDraft.deleteMany()
  await prisma.itemOutletOverride.deleteMany()
  await prisma.comboComponent.deleteMany()
  await prisma.combo.deleteMany()
  await prisma.itemAllergen.deleteMany()
  await prisma.allergen.deleteMany()
  await prisma.itemModifierGroup.deleteMany()
  await prisma.modifier.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.itemPrice.deleteMany()
  await prisma.itemVariant.deleteMany()
  await prisma.menuItem.deleteMany()
  await prisma.menuCategory.deleteMany()
  await prisma.billShare.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
  await prisma.ticketEvent.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  // qr-self-order/CAP-1 (guest realm, issue #68): Guest FKs to table_sessions
  // (RESTRICT), and table_sessions FKs to dining_tables/outlets - both wiped
  // before diningTable.deleteMany() below for the same reason.
  await prisma.guest.deleteMany()
  await prisma.tableSession.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

async function createTenant(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<string> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+91 90000 00000',
      country: 'IN',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return tenantId
}

async function seedStaff(
  prisma: PrismaClient,
  tenantId: string,
  opts: { name: string; roleName: string; isManager: boolean; pin: string },
): Promise<{ id: string; name: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: opts.roleName, isSystem: true, isManager: opts.isManager } })
  const pinHash = await argon2.hash(opts.pin)
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: opts.name, pinHash } })
  return { id: staff.id, name: staff.name }
}

describe('ManagerAuthService (CAP-8, e2e)', () => {
  let prisma: PrismaClient
  let service: ManagerAuthService

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

    const moduleRef = await Test.createTestingModule({ imports: [PlatformModule] }).compile()
    service = moduleRef.get(ManagerAuthService)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  it('approves a valid manager PIN with a reason, returning the correct approver identity', async () => {
    const tenantId = await createTenant(prisma)
    const manager = await seedStaff(prisma, tenantId, { name: 'Meera Manager', roleName: 'Manager', isManager: true, pin: '1234' })

    const approval = await service.authorize('void_after_fire', tenantId, uuidv7(), '1234', 'Kitchen fired the wrong dish')

    expect(approval).toMatchObject({
      approverId: manager.id,
      approverName: 'Meera Manager',
      roleName: 'Manager',
      tenantId,
      actionType: 'void_after_fire',
      reason: 'Kitchen fired the wrong dish',
    })
  })

  it('rejects a wrong PIN', async () => {
    const tenantId = await createTenant(prisma)
    await seedStaff(prisma, tenantId, { name: 'Meera Manager', roleName: 'Manager', isManager: true, pin: '1234' })

    await expect(service.authorize('void_after_fire', tenantId, uuidv7(), '9999', 'Kitchen fired the wrong dish')).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('rejects a missing reason before checking the PIN (cheapest-check-first)', async () => {
    const tenantId = await createTenant(prisma)
    // Deliberately seed no manager at all - if the reason check ran after a
    // PIN lookup this would still throw, but for the wrong cause (no
    // candidates) instead of the validation error this test is pinning down.
    await expect(service.authorize('void_after_fire', tenantId, uuidv7(), '1234', '')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.authorize('void_after_fire', tenantId, uuidv7(), '1234', '   ')).rejects.toBeInstanceOf(BadRequestException)
  })

  it("rejects a non-manager StaffUser's correct PIN", async () => {
    const tenantId = await createTenant(prisma)
    await seedStaff(prisma, tenantId, { name: 'Wasim Waiter', roleName: 'Waiter', isManager: false, pin: '1234' })

    await expect(service.authorize('void_after_fire', tenantId, uuidv7(), '1234', 'Trying to self-approve')).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('never matches a manager PIN belonging to a different tenant (cross-tenant isolation)', async () => {
    const tenantA = await createTenant(prisma, 'Tenant A')
    const tenantB = await createTenant(prisma, 'Tenant B')
    await seedStaff(prisma, tenantB, { name: 'Tenant B Manager', roleName: 'Manager', isManager: true, pin: '1234' })

    await expect(service.authorize('void_after_fire', tenantA, uuidv7(), '1234', 'reason')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('recordApproval writes actor, approver, reason, and both timestamps into audit_events, inside the caller\'s own transaction', async () => {
    const tenantId = await createTenant(prisma)
    const manager = await seedStaff(prisma, tenantId, { name: 'Meera Manager', roleName: 'Manager', isManager: true, pin: '1234' })
    const actorId = uuidv7()

    const approval = await service.authorize('refund', tenantId, uuidv7(), '1234', 'Customer sent back a cold dish')
    const occurredAt = new Date()

    // Stands in for a caller's own mutation transaction (AD-6: the audit
    // row lands in the same transaction as the mutation it gates).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      await service.recordApproval(tx, approval, { actorId, actorEmail: 'cashier@spiceroute.example', occurredAt })
    })

    const row = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'refund' } })
    expect(row).toMatchObject({
      tenantId,
      actorId,
      actorEmail: 'cashier@spiceroute.example',
      approverId: manager.id,
      approverName: 'Meera Manager',
      action: 'refund',
      reason: 'Customer sent back a cold dish',
    })
    expect(row?.occurredAt.getTime()).toBe(occurredAt.getTime())
    expect(row?.recordedAt).toBeTruthy()
  })
})
