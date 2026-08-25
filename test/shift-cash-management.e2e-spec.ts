// pos/CAP-10 success criteria, end to end: a cashier can open a shift with a
// starting float; a second open shift on the same outlet is rejected (409);
// paid-outs and bank-drops log against the open shift; closing with a
// counted amount computes expectedMinor (float - paid_outs - bank_drops for
// this story, per AD-14's note that Order/Bill don't exist yet) and
// overShortMinor together, atomically, and stores them once; and - the
// load-bearing AD-14 requirement - no endpoint or response field ever
// reveals expectedMinor for an open shift before its close is submitted.
//
// NOTE: pos/CAP-1 (issue #44) owns the real PIN-login endpoint that mints a
// pos-realm session token. It hadn't landed any commits when this story
// started, so this suite signs tokens directly with signPosToken (the same
// stub primitive src/platform/pos-jwt.ts implements) rather than going
// through a login endpoint that doesn't exist yet. Reconcile call-sites here
// if #44 changes the token's claim shape.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface CashMovementBody {
  id: string
  type: string
  amountMinor: number
  reason: string
  createdByStaffId: string
  createdAt: string
}
interface ShiftBody {
  id: string
  tenantId: string
  outletId: string
  openedByStaffId: string
  floatMinor: number
  openedAt: string
  closedByStaffId: string | null
  closedAt: string | null
  countedMinor: number | null
  expectedMinor: number | null
  overShortMinor: number | null
  cashMovements: CashMovementBody[]
}

// Deletes every table in the schema, not just this story's own - the e2e
// suites share one test database (fileParallelism: false) and each file's
// wipe() must be able to clean up after any other file that ran before it,
// same convention every other *.e2e-spec.ts follows (see e.g.
// reports-catalogue.e2e-spec.ts's wipe(), the most complete one prior to
// this story - cash_movements/shifts are new here, prepended in FK order).
async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
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
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.order.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

/**
 * A cashier staff member for a tenant, plus a signed pos-realm session for
 * them. `outletId` is a placeholder here (this suite's shift endpoints take
 * the outlet explicitly in the request, never from the token - see
 * shifts.service.ts, which never reads `staff.outletId`), just enough to
 * satisfy the real `PosPrincipal` shape settled by pos/CAP-1 (issue #44).
 */
async function createCashier(prisma: PrismaClient, tenantId: string, name = 'Priya Nair'): Promise<{ staffId: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: 'Cashier', isSystem: true } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId: uuidv7(), name })
  return { staffId: staff.id, token }
}

describe('/pos/v1/shifts (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  function authed(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  describe('POST /pos/v1/shifts', () => {
    it('opens a shift with a starting float', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { staffId, token } = await createCashier(prisma, tenantId)

      const res = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 500000 })
      expect(res.status).toBe(201)
      const body = res.body as ShiftBody
      expect(body).toMatchObject({
        tenantId,
        outletId,
        openedByStaffId: staffId,
        floatMinor: 500000,
        closedAt: null,
        closedByStaffId: null,
        countedMinor: null,
        expectedMinor: null,
        overShortMinor: null,
        cashMovements: [],
      })

      const row = await prisma.shift.findUnique({ where: { id: body.id } })
      expect(row?.tenantId).toBe(tenantId)
      expect(row?.floatMinor).toBe(500000n)
    })

    it('rejects a second open shift on the same outlet (409)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)

      const first = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 200000 })
      expect(first.status).toBe(201)

      const second = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 300000 })
      expect(second.status).toBe(409)
      expect((second.body as ErrorBody).error.code).toBe('shift_already_open')

      // Only the first shift exists - the rejected attempt left no row behind.
      const shifts = await prisma.shift.findMany({ where: { outletId } })
      expect(shifts).toHaveLength(1)
      expect(shifts[0]?.floatMinor).toBe(200000n)
    })

    it('a closed shift frees the outlet for a new open shift', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)

      const opened = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 100000 })
      const shiftId = (opened.body as ShiftBody).id
      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 100000 })

      const reopened = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 150000 })
      expect(reopened.status).toBe(201)
    })

    it('rejects an outlet from a different tenant (400)', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const { token } = await createCashier(prisma, tenantA)

      const res = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId: outletB, floatMinor: 100000 })
      expect(res.status).toBe(400)
    })

    it('rejects without a pos token', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).post('/pos/v1/shifts').send({ outletId, floatMinor: 100000 })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /pos/v1/shifts/:id/cash-movements', () => {
    async function openShift(token: string, outletId: string, floatMinor = 500000): Promise<string> {
      const res = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor })
      return (res.body as ShiftBody).id
    }

    it('logs a paid-out and a bank-drop against the open shift', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { staffId, token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId)

      const paidOut = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({
        type: 'paid_out',
        amountMinor: 15000,
        reason: 'Vegetable vendor cash payment',
      })
      expect(paidOut.status).toBe(201)
      let body = paidOut.body as ShiftBody
      expect(body.cashMovements).toHaveLength(1)
      expect(body.cashMovements[0]).toMatchObject({ type: 'paid_out', amountMinor: 15000, reason: 'Vegetable vendor cash payment', createdByStaffId: staffId })

      const bankDrop = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({
        type: 'bank_drop',
        amountMinor: 200000,
        reason: 'Midday drop to safe',
      })
      expect(bankDrop.status).toBe(201)
      body = bankDrop.body as ShiftBody
      expect(body.cashMovements).toHaveLength(2)

      const rows = await prisma.cashMovement.findMany({ where: { shiftId } })
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.tenantId === tenantId)).toBe(true)
    })

    it('rejects a cash movement with no reason (400)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId)

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'paid_out', amountMinor: 1000 })
      expect(res.status).toBe(400)
    })

    it('rejects logging against an already-closed shift (409)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId)
      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 500000 })

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'paid_out', amountMinor: 1000, reason: 'x' })
      expect(res.status).toBe(409)
    })

    it('404s a shift belonging to another tenant (cross-tenant isolation)', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletA = await createOutlet(prisma, tenantA)
      const { token: tokenA } = await createCashier(prisma, tenantA)
      const { token: tokenB } = await createCashier(prisma, tenantB)
      const shiftId = await openShift(tokenA, outletA)

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), tokenB).send({ type: 'paid_out', amountMinor: 1000, reason: 'x' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /pos/v1/shifts/:id/close - blind count', () => {
    async function openShift(token: string, outletId: string, floatMinor: number): Promise<string> {
      const res = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor })
      return (res.body as ShiftBody).id
    }

    it('computes expected and over/short from float minus paid-outs and bank-drops', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { staffId, token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId, 500000)

      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'paid_out', amountMinor: 20000, reason: 'Vendor payment' })
      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'bank_drop', amountMinor: 100000, reason: 'Safe drop' })

      // expected = 500000 - 20000 - 100000 = 380000
      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 375000 })
      expect(res.status).toBe(200)
      const body = res.body as ShiftBody
      expect(body.expectedMinor).toBe(380000)
      expect(body.countedMinor).toBe(375000)
      // short by 5000
      expect(body.overShortMinor).toBe(-5000)
      expect(body.closedByStaffId).toBe(staffId)
      expect(body.closedAt).not.toBeNull()

      const row = await prisma.shift.findUnique({ where: { id: shiftId } })
      expect(row?.expectedMinor).toBe(380000n)
      expect(row?.countedMinor).toBe(375000n)
      expect(row?.overShortMinor).toBe(-5000n)
    })

    it('records a positive over/short when counted exceeds expected', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId, 100000)

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 103000 })
      expect(res.status).toBe(200)
      const body = res.body as ShiftBody
      expect(body.expectedMinor).toBe(100000)
      expect(body.overShortMinor).toBe(3000)
    })

    it('folds real finalised cash-tender bill totals into expected (pos/CAP-7 Bill & Settle)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { staffId, token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId, 50000)

      // A bill finalised at this outlet while the shift is open, settled
      // partly cash and partly UPI - only the cash tender counts toward the
      // till. Created directly via Prisma: the bill/finalise HTTP flow
      // itself is covered by test/pos-bills.e2e-spec.ts, this test only
      // pins down closeShift()'s arithmetic.
      const order = await prisma.order.create({ data: { tenantId, outletId, ownerId: staffId, status: 'closed' } })
      const bill = await prisma.bill.create({
        data: {
          tenantId,
          outletId,
          orderId: order.id,
          billNumber: 1,
          subtotalMinor: 100000n,
          taxMinor: 5000n,
          status: 'finalized',
          createdByStaffId: staffId,
          finalizedByStaffId: staffId,
          finalizedAt: new Date(),
        },
      })
      await prisma.tender.create({ data: { tenantId, billId: bill.id, method: 'cash', amountMinor: 80000n } })
      await prisma.tender.create({ data: { tenantId, billId: bill.id, method: 'upi_manual', amountMinor: 25000n } })

      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'paid_out', amountMinor: 10000, reason: 'Vendor payment' })

      // expected = float(50000) + cash tenders(80000) - paid_out(10000) = 120000
      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 120000 })
      expect(res.status).toBe(200)
      expect((res.body as ShiftBody).expectedMinor).toBe(120000)
      expect((res.body as ShiftBody).overShortMinor).toBe(0)
    })

    it('never folds a bill finalised before the shift opened, or at another outlet, into expected', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const otherOutletId = await createOutlet(prisma, tenantId, 'Other Outlet')
      const { staffId, token } = await createCashier(prisma, tenantId)

      // Finalised BEFORE this test's shift ever opens.
      const staleOrder = await prisma.order.create({ data: { tenantId, outletId, ownerId: staffId, status: 'closed' } })
      const staleBill = await prisma.bill.create({
        data: { tenantId, outletId, orderId: staleOrder.id, billNumber: 1, subtotalMinor: 100000n, taxMinor: 5000n, status: 'finalized', createdByStaffId: staffId, finalizedByStaffId: staffId, finalizedAt: new Date(Date.now() - 60_000) },
      })
      await prisma.tender.create({ data: { tenantId, billId: staleBill.id, method: 'cash', amountMinor: 999999n } })

      const shiftId = await openShift(token, outletId, 50000)

      // Finalised at a DIFFERENT outlet, after this shift opened.
      const otherOrder = await prisma.order.create({ data: { tenantId, outletId: otherOutletId, ownerId: staffId, status: 'closed' } })
      const otherBill = await prisma.bill.create({
        data: { tenantId, outletId: otherOutletId, orderId: otherOrder.id, billNumber: 1, subtotalMinor: 100000n, taxMinor: 5000n, status: 'finalized', createdByStaffId: staffId, finalizedByStaffId: staffId, finalizedAt: new Date() },
      })
      await prisma.tender.create({ data: { tenantId, billId: otherBill.id, method: 'cash', amountMinor: 999999n } })

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 50000 })
      expect(res.status).toBe(200)
      expect((res.body as ShiftBody).expectedMinor).toBe(50000)
    })

    it('rejects closing an already-closed shift (409) - insert-only past finalisation', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId, 100000)

      const first = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 100000 })
      expect(first.status).toBe(200)

      const second = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 999999 })
      expect(second.status).toBe(409)

      // The first close's figures were never overwritten by the rejected second attempt.
      const row = await prisma.shift.findUnique({ where: { id: shiftId } })
      expect(row?.countedMinor).toBe(100000n)
    })

    it('rejects a close with no countedMinor (400)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const shiftId = await openShift(token, outletId, 100000)

      const res = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({})
      expect(res.status).toBe(400)
    })
  })

  // AD-14's load-bearing requirement: the counted amount must be entered
  // before the system reveals the computed expected amount - never the
  // other order. Verified here as a property of every read path this story
  // exposes, not just the close endpoint's input validation.
  describe('blind-count enforcement (AD-14)', () => {
    it('never exposes expectedMinor for an open shift, from any read path, before close is called', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)

      const opened = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 500000 })
      const shiftId = (opened.body as ShiftBody).id
      expect((opened.body as ShiftBody).expectedMinor).toBeNull()

      await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'paid_out', amountMinor: 10000, reason: 'x' })

      // GET by id, while open: still no expected figure anywhere in the body.
      const getById = await authed(request(httpServer).get(`/pos/v1/shifts/${shiftId}`), token)
      expect(getById.status).toBe(200)
      expect((getById.body as ShiftBody).expectedMinor).toBeNull()
      // Nothing in the response body carries a computed expected figure
      // under any other key either - not just the expectedMinor field.
      expect(JSON.stringify(getById.body)).not.toMatch(/[Ee]xpected[a-zA-Z]*":\s*-?\d/)

      // GET current, while open: same.
      const getCurrent = await authed(request(httpServer).get(`/pos/v1/shifts/current?outletId=${outletId}`), token)
      expect(getCurrent.status).toBe(200)
      expect((getCurrent.body as ShiftBody).expectedMinor).toBeNull()

      // Logging another movement: still no expected figure in the response.
      const afterMovement = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/cash-movements`), token).send({ type: 'bank_drop', amountMinor: 5000, reason: 'y' })
      expect((afterMovement.body as ShiftBody).expectedMinor).toBeNull()

      // Only now, once countedMinor is submitted to close(), does expectedMinor appear - computed and stored in the same call.
      const closed = await authed(request(httpServer).post(`/pos/v1/shifts/${shiftId}/close`), token).send({ countedMinor: 485000 })
      expect(closed.status).toBe(200)
      const closedBody = closed.body as ShiftBody
      expect(closedBody.expectedMinor).toBe(485000) // 500000 - 10000 - 5000
      expect(closedBody.overShortMinor).toBe(0)
    })

    it('there is no endpoint that computes or returns an expected amount independent of close()', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)
      const opened = await authed(request(httpServer).post('/pos/v1/shifts'), token).send({ outletId, floatMinor: 500000 })
      const shiftId = (opened.body as ShiftBody).id

      // Plausible guesses for a "peek" endpoint - all must not exist (404) or
      // must not resolve to a route (any other 4xx not fabricating a value).
      const guesses = [
        `/pos/v1/shifts/${shiftId}/expected`,
        `/pos/v1/shifts/${shiftId}/preview-close`,
        `/pos/v1/shifts/${shiftId}/expected-amount`,
      ]
      for (const path of guesses) {
        const res = await authed(request(httpServer).get(path), token)
        expect(res.status).not.toBe(200)
      }
    })
  })

  describe('GET /pos/v1/shifts/current', () => {
    it('404s when there is no open shift for the outlet', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { token } = await createCashier(prisma, tenantId)

      const res = await authed(request(httpServer).get(`/pos/v1/shifts/current?outletId=${outletId}`), token)
      expect(res.status).toBe(404)
    })
  })
})
