// CAP-5 success criteria, end to end:
//  - a floor plan with overlapping table positions is rejected (409), never
//    silently saved (this story's overlap policy: reject, not auto-adjust)
//  - every station has a printer or an explicit "no printer" acknowledgement
//  - the go-live checklist's floor_plan step flips on the first table
//    created for an outlet
//  - every read is scoped to the signed-in tenant (cross-tenant isolation, NFR-8)
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface TableBody {
  id: string
  floorId: string
  label: string
  x: number
  y: number
  width: number
  height: number
  shape: string
  seatCapacity: number
}
interface FloorBody {
  id: string
  outletId: string
  name: string
  sortOrder: number
  tables: TableBody[]
}
interface PrinterBody {
  id: string
  outletId: string
  name: string
  renderMode: string
}
interface StationBody {
  id: string
  outletId: string
  name: string
  ageingThresholdMinutes: number
  primaryPrinterId: string | null
  fallbackPrinterId: string | null
}
interface FloorPlanBody {
  floors: FloorBody[]
  stations: StationBody[]
  printers: PrinterBody[]
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
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
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

async function createOwner(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<{ tenantId: string; token: string }> {
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
  const token = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
  return { tenantId, token }
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

describe('/admin/v1/outlets/:outletId/floor-plan (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
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

  function base(outletId: string): string {
    return `/admin/v1/outlets/${outletId}/floor-plan`
  }

  describe('floors and tables', () => {
    it('creates a floor, then a table on it, and reads both back in the full floor plan', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const floorRes = await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })
      expect(floorRes.status).toBe(201)
      const floor = floorRes.body as FloorBody
      expect(floor).toMatchObject({ outletId, name: 'Ground Floor', sortOrder: 0, tables: [] })

      const tableRes = await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({
        floorId: floor.id,
        label: 'T1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        shape: 'circle',
        seatCapacity: 2,
      })
      expect(tableRes.status).toBe(201)
      const table = tableRes.body as TableBody
      expect(table).toMatchObject({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'circle', seatCapacity: 2 })

      const planRes = await authed(request(httpServer).get(base(outletId)), token)
      expect(planRes.status).toBe(200)
      const plan = planRes.body as FloorPlanBody
      expect(plan.floors).toHaveLength(1)
      expect(plan.floors[0]?.tables).toEqual([table])
    })

    it('rejects a table that overlaps an existing table on the same floor (409, not silently saved or moved)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody

      const firstRes = await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({
        floorId: floor.id,
        label: 'T1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        shape: 'square',
        seatCapacity: 4,
      })
      expect(firstRes.status).toBe(201)

      // Overlaps T1's [0,10)x[0,10) box by 5 units in both axes.
      const overlapRes = await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({
        floorId: floor.id,
        label: 'T2',
        x: 5,
        y: 5,
        width: 10,
        height: 10,
        shape: 'square',
        seatCapacity: 4,
      })
      expect(overlapRes.status).toBe(409)
      expect((overlapRes.body as ErrorBody).error.code).toBe('table_overlap')

      const planRes = await authed(request(httpServer).get(base(outletId)), token)
      expect((planRes.body as FloorPlanBody).floors[0]?.tables).toHaveLength(1)
    })

    it('allows a table that merely touches the edge of another (no overlap)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 })

      const adjacentRes = await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({
        floorId: floor.id,
        label: 'T2',
        x: 10,
        y: 0,
        width: 10,
        height: 10,
        shape: 'square',
        seatCapacity: 4,
      })
      expect(adjacentRes.status).toBe(201)
    })

    it('rejects moving a table on top of another via PATCH (409)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 })
      const t2 = (
        await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T2', x: 20, y: 20, width: 10, height: 10, shape: 'square', seatCapacity: 4 })
      ).body as TableBody

      const moveRes = await authed(request(httpServer).patch(`${base(outletId)}/tables/${t2.id}`), token).send({ x: 0, y: 0 })
      expect(moveRes.status).toBe(409)
    })

    it('allows a table to move without triggering overlap against itself', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      const t1 = (
        await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 })
      ).body as TableBody

      const moveRes = await authed(request(httpServer).patch(`${base(outletId)}/tables/${t1.id}`), token).send({ x: 1, y: 1 })
      expect(moveRes.status).toBe(200)
      expect((moveRes.body as TableBody).x).toBe(1)
    })

    it('deletes a table', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      const table = (
        await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 })
      ).body as TableBody

      const delRes = await authed(request(httpServer).delete(`${base(outletId)}/tables/${table.id}`), token)
      expect(delRes.status).toBe(204)

      const planRes = await authed(request(httpServer).get(base(outletId)), token)
      expect((planRes.body as FloorPlanBody).floors[0]?.tables).toEqual([])
    })
  })

  describe('go-live checklist integration', () => {
    it('flips the floor_plan checklist step on the first table created for the outlet', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const before = await prisma.checklistProgress.findUnique({ where: { tenantId } })
      expect(before?.floorPlanAt ?? null).toBeNull()

      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      // Floor alone must not flip it - only floor + table together.
      expect((await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.floorPlanAt ?? null).toBeNull()

      await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'circle', seatCapacity: 2 })

      const after = await prisma.checklistProgress.findUnique({ where: { tenantId } })
      expect(after?.floorPlanAt).not.toBeNull()
    })

    it('does not re-fire on a second table (already flipped stays flipped, no error)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), token).send({ name: 'Ground Floor' })).body as FloorBody
      await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'circle', seatCapacity: 2 })
      const firstFlipAt = (await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.floorPlanAt

      const res = await authed(request(httpServer).post(`${base(outletId)}/tables`), token).send({ floorId: floor.id, label: 'T2', x: 50, y: 50, width: 10, height: 10, shape: 'circle', seatCapacity: 2 })
      expect(res.status).toBe(201)
      expect((await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.floorPlanAt).toEqual(firstFlipAt)
    })
  })

  describe('stations and printers', () => {
    it('rejects creating a station with no printer and no acknowledgement (400)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const res = await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({ name: 'Fry', ageingThresholdMinutes: 10 })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('printer_required')
    })

    it('creates a station with no printer when explicitly acknowledged', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const res = await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({
        name: 'Fry',
        ageingThresholdMinutes: 10,
        noPrinterAcknowledged: true,
      })
      expect(res.status).toBe(201)
      const body = res.body as StationBody
      expect(body).toMatchObject({ outletId, name: 'Fry', ageingThresholdMinutes: 10, primaryPrinterId: null, fallbackPrinterId: null })
    })

    it('creates a station with a primary and fallback printer', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const primary = (await authed(request(httpServer).post(`${base(outletId)}/printers`), token).send({ name: 'HOT Printer 1', renderMode: 'text' })).body as PrinterBody
      const fallback = (await authed(request(httpServer).post(`${base(outletId)}/printers`), token).send({ name: 'HOT Printer 2', renderMode: 'bitmap' })).body as PrinterBody

      const res = await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({
        name: 'Expo',
        ageingThresholdMinutes: 5,
        primaryPrinterId: primary.id,
        fallbackPrinterId: fallback.id,
      })
      expect(res.status).toBe(201)
      const body = res.body as StationBody
      expect(body.primaryPrinterId).toBe(primary.id)
      expect(body.fallbackPrinterId).toBe(fallback.id)
    })

    it('rejects a printer that belongs to a different outlet', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId, 'Indiranagar')
      const otherOutletId = await createOutlet(prisma, tenantId, 'Koramangala')
      const foreignPrinter = (await authed(request(httpServer).post(`${base(otherOutletId)}/printers`), token).send({ name: 'HOT Printer', renderMode: 'text' })).body as PrinterBody

      const res = await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({
        name: 'Expo',
        ageingThresholdMinutes: 5,
        primaryPrinterId: foreignPrinter.id,
      })
      expect(res.status).toBe(400)
    })

    it('rejects clearing a station printer via PATCH without acknowledgement', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const printer = (await authed(request(httpServer).post(`${base(outletId)}/printers`), token).send({ name: 'HOT Printer 1', renderMode: 'text' })).body as PrinterBody
      const station = (
        await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({ name: 'Expo', ageingThresholdMinutes: 5, primaryPrinterId: printer.id })
      ).body as StationBody

      const res = await authed(request(httpServer).patch(`${base(outletId)}/stations/${station.id}`), token).send({ primaryPrinterId: null })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('printer_required')
    })

    it('allows clearing a station printer via PATCH with acknowledgement', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const printer = (await authed(request(httpServer).post(`${base(outletId)}/printers`), token).send({ name: 'HOT Printer 1', renderMode: 'text' })).body as PrinterBody
      const station = (
        await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({ name: 'Expo', ageingThresholdMinutes: 5, primaryPrinterId: printer.id })
      ).body as StationBody

      const res = await authed(request(httpServer).patch(`${base(outletId)}/stations/${station.id}`), token).send({ primaryPrinterId: null, noPrinterAcknowledged: true })
      expect(res.status).toBe(200)
      expect((res.body as StationBody).primaryPrinterId).toBeNull()
    })

    it('leaves the printer untouched when a PATCH does not mention it', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const printer = (await authed(request(httpServer).post(`${base(outletId)}/printers`), token).send({ name: 'HOT Printer 1', renderMode: 'text' })).body as PrinterBody
      const station = (
        await authed(request(httpServer).post(`${base(outletId)}/stations`), token).send({ name: 'Expo', ageingThresholdMinutes: 5, primaryPrinterId: printer.id })
      ).body as StationBody

      const res = await authed(request(httpServer).patch(`${base(outletId)}/stations/${station.id}`), token).send({ ageingThresholdMinutes: 8 })
      expect(res.status).toBe(200)
      const body = res.body as StationBody
      expect(body.ageingThresholdMinutes).toBe(8)
      expect(body.primaryPrinterId).toBe(printer.id)
    })
  })

  describe('tenant isolation', () => {
    it('never returns another tenant’s floor plan (404, not leaked as another shape)', async () => {
      const owner = await createOwner(prisma, 'Spice Route Hospitality')
      const other = await createOwner(prisma, 'Curry Leaf Kitchens')
      const otherOutletId = await createOutlet(prisma, other.tenantId, 'Koramangala')

      const res = await authed(request(httpServer).get(base(otherOutletId)), owner.token)
      expect(res.status).toBe(404)
    })

    it('rejects creating a floor on another tenant’s outlet', async () => {
      const owner = await createOwner(prisma, 'Spice Route Hospitality')
      const other = await createOwner(prisma, 'Curry Leaf Kitchens')
      const otherOutletId = await createOutlet(prisma, other.tenantId, 'Koramangala')

      const res = await authed(request(httpServer).post(`${base(otherOutletId)}/floors`), owner.token).send({ name: 'Ground Floor' })
      expect(res.status).toBe(404)
    })

    it('never shows one outlet’s floor plan through a second tenant’s reads', async () => {
      const owner = await createOwner(prisma, 'Spice Route Hospitality')
      const other = await createOwner(prisma, 'Curry Leaf Kitchens')
      const outletId = await createOutlet(prisma, owner.tenantId, 'Indiranagar')
      const floor = (await authed(request(httpServer).post(`${base(outletId)}/floors`), owner.token).send({ name: 'Ground Floor' })).body as FloorBody
      await authed(request(httpServer).post(`${base(outletId)}/tables`), owner.token).send({ floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'circle', seatCapacity: 2 })

      const res = await authed(request(httpServer).get(base(outletId)), other.token)
      expect(res.status).toBe(404)
    })

    it('rejects a request with no admin session', async () => {
      const { tenantId } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).get(base(outletId))
      expect(res.status).toBe(401)
    })
  })
})
