// tenant-admin/CAP-9 success criteria, end to end: the reports catalogue
// never fabricates data for report types that depend on the (unbuilt) POS
// Core Loop - every Sales/Financial/Menu-Engineering/Operations/Inventory/
// Labour-cost entry is honestly hasData:false with an explanatory message
// and no export formats. Menu Catalogue and Staff Roster ARE backed by real
// tenant tables and export a real CSV matching the seeded rows, scoped to
// the caller's own tenant. The accounting export destination list is static
// and every destination is honestly "not_connected" - no OAuth/API
// integration to any of them exists yet.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

type ReportCategory = 'sales' | 'financial' | 'menu' | 'operations' | 'inventory' | 'labour'
interface ReportCatalogueEntry {
  key: string
  name: string
  category: ReportCategory
  hasData: boolean
  message: string
  exportFormats: string[]
}
interface ExportDestinationView {
  key: string
  name: string
  status: string
}

async function wipe(prisma: PrismaClient): Promise<void> {
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
  const token = signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@spiceroute.example` })
  return { tenantId, token }
}

async function createPricedItem(
  prisma: PrismaClient,
  tenantId: string,
  categoryName: string,
  itemName: string,
  priceMinor: number,
  currency = 'INR',
): Promise<void> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: categoryName, sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: itemName, shortName: itemName.slice(0, 8), available: true } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, channel: 'dine_in', priceMinor: BigInt(priceMinor), currency, effectiveAt: new Date(Date.now() - 1000) } })
}

async function createStaffMember(prisma: PrismaClient, tenantId: string, name: string, roleName: string): Promise<void> {
  const role = await prisma.role.create({ data: { tenantId, name: roleName, isSystem: true } })
  await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name, email: `${name.toLowerCase()}@spiceroute.example` } })
}

function parseCsv(csv: string): string[][] {
  return csv
    .trim()
    .split('\r\n')
    .map((line) => line.split(','))
}

describe('/admin/v1/reports (e2e)', () => {
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

  describe('catalogue', () => {
    it('honestly reports hasData:false with no export formats for every report type that depends on the POS Core Loop', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/reports'), token)
      expect(res.status).toBe(200)
      const body = res.body as ReportCatalogueEntry[]

      const pendingKeys = ['sales-summary', 'gst-bas', 'menu-engineering', 'operations-summary', 'inventory-summary', 'labour-cost']
      for (const key of pendingKeys) {
        const entry = body.find((e) => e.key === key)
        expect(entry, `expected a catalogue entry for ${key}`).toBeDefined()
        expect(entry?.hasData).toBe(false)
        expect(entry?.exportFormats).toEqual([])
        expect(entry?.message.length).toBeGreaterThan(0)
      }

      // Every named category from the SPEC is represented.
      const categories = new Set(body.map((e) => e.category))
      expect(categories).toEqual(new Set(['sales', 'financial', 'menu', 'operations', 'inventory', 'labour']))
    })

    it('honestly reports hasData:true with a csv export for the two reports backed by real tables', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/reports'), token)
      const body = res.body as ReportCatalogueEntry[]

      const menuCatalogue = body.find((e) => e.key === 'menu-catalogue')
      expect(menuCatalogue?.hasData).toBe(true)
      expect(menuCatalogue?.exportFormats).toEqual(['csv'])

      const staffRoster = body.find((e) => e.key === 'staff-roster')
      expect(staffRoster?.hasData).toBe(true)
      expect(staffRoster?.exportFormats).toEqual(['csv'])
    })

    it('rejects without an admin token', async () => {
      const res = await request(httpServer).get('/admin/v1/reports')
      expect(res.status).toBe(401)
    })
  })

  describe('export-destinations', () => {
    it('lists every accounting destination as honestly not_connected - no integration is built', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/reports/export-destinations'), token)
      expect(res.status).toBe(200)
      const body = res.body as ExportDestinationView[]

      const names = body.map((d) => d.name).sort()
      expect(names).toEqual(['MYOB', 'QuickBooks', 'Tally', 'Xero', 'Zoho Books'])
      for (const destination of body) {
        expect(destination.status).toBe('not_connected')
      }
    })
  })

  describe('menu-catalogue export', () => {
    it('exports a real CSV matching the actual seeded menu data', async () => {
      const { tenantId, token } = await createOwner(prisma)
      await createPricedItem(prisma, tenantId, 'Mains', 'Butter Chicken', 45000)
      await createPricedItem(prisma, tenantId, 'Starters', 'Paneer Tikka', 28000)

      const res = await authed(request(httpServer).get('/admin/v1/reports/menu-catalogue/export?format=csv'), token)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')

      const rows = parseCsv(res.text)
      expect(rows[0]).toEqual(['category', 'item', 'short_name', 'variant', 'price', 'currency', 'available'])
      const dataRows = rows.slice(1)
      expect(dataRows).toHaveLength(2)
      expect(dataRows).toContainEqual(['Mains', 'Butter Chicken', 'Butter C', '', '450.00', 'INR', 'yes'])
      expect(dataRows).toContainEqual(['Starters', 'Paneer Tikka', 'Paneer T', '', '280.00', 'INR', 'yes'])
    })

    it('exports an empty price for an item with no current price row, never a fabricated one', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
      await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Unpriced Dish', shortName: 'Unpriced', available: true } })

      const res = await authed(request(httpServer).get('/admin/v1/reports/menu-catalogue/export?format=csv'), token)
      const rows = parseCsv(res.text)
      expect(rows[1]).toEqual(['Mains', 'Unpriced Dish', 'Unpriced', '', '', '', 'yes'])
    })

    it('never returns another tenant\'s menu items (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      await createPricedItem(prisma, ownerA.tenantId, 'Mains', 'A Dish', 10000)
      await createPricedItem(prisma, ownerB.tenantId, 'Mains', 'B Dish', 20000)

      const res = await authed(request(httpServer).get('/admin/v1/reports/menu-catalogue/export?format=csv'), ownerA.token)
      const rows = parseCsv(res.text)
      const dataRows = rows.slice(1)
      expect(dataRows).toHaveLength(1)
      expect(dataRows[0]?.[1]).toBe('A Dish')
    })

    it('rejects an unsupported export format', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/reports/menu-catalogue/export?format=xlsx'), token)
      expect(res.status).toBe(400)
    })

    it('rejects without an admin token', async () => {
      const res = await request(httpServer).get('/admin/v1/reports/menu-catalogue/export?format=csv')
      expect(res.status).toBe(401)
    })
  })

  describe('staff-roster export', () => {
    it('exports a real CSV matching the actual seeded staff', async () => {
      const { tenantId, token } = await createOwner(prisma)
      await createStaffMember(prisma, tenantId, 'Asha', 'Manager')
      await createStaffMember(prisma, tenantId, 'Rahul', 'Waiter')

      const res = await authed(request(httpServer).get('/admin/v1/reports/staff-roster/export?format=csv'), token)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')

      const rows = parseCsv(res.text)
      expect(rows[0]).toEqual(['name', 'email', 'role', 'pin_status'])
      const dataRows = rows.slice(1)
      expect(dataRows).toContainEqual(['Asha', 'asha@spiceroute.example', 'Manager', 'none'])
      expect(dataRows).toContainEqual(['Rahul', 'rahul@spiceroute.example', 'Waiter', 'none'])
    })

    it('never returns another tenant\'s staff (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      await createStaffMember(prisma, ownerA.tenantId, 'Asha', 'Manager')
      await createStaffMember(prisma, ownerB.tenantId, 'Priya', 'Manager')

      const res = await authed(request(httpServer).get('/admin/v1/reports/staff-roster/export?format=csv'), ownerA.token)
      const rows = parseCsv(res.text)
      const dataRows = rows.slice(1)
      expect(dataRows).toHaveLength(1)
      expect(dataRows[0]?.[0]).toBe('Asha')
    })

    it('rejects an unsupported export format', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/reports/staff-roster/export?format=json'), token)
      expect(res.status).toBe(400)
    })

    it('rejects without an admin token', async () => {
      const res = await request(httpServer).get('/admin/v1/reports/staff-roster/export?format=csv')
      expect(res.status).toBe(401)
    })
  })
})
