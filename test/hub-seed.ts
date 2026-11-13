// Hub mode (#293) test data: one tenant with an outlet, a cashier with an
// argon2 PIN hash and one priced menu item. Shared by src/hub/hub.spec.ts and
// scripts/smoke-hub.ts.
import type { PGlite } from '@electric-sql/pglite'
import * as argon2 from 'argon2'
import type { PrismaClient } from '../src/db/client'
import { APP_ROLE } from '../src/hub/store'
import { uuidv7 } from '../src/platform'

export const HUB_PIN = '4321'

export interface HubSeed {
  tenantId: string
  outletId: string
  staffId: string
  itemId: string
}

/** Seeds as PGlite's superuser (as the bootstrap import will), then hands the connection back to the app role. */
export async function seedHubTenant(pg: PGlite, prisma: PrismaClient, name: string): Promise<HubSeed> {
  await pg.exec('RESET ROLE')
  try {
    const tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name,
        registeredAddress: '1 Test Street',
        contactName: 'Test Contact',
        contactEmail: `${tenantId}@test.example`,
        contactPhone: '+91 90000 00000',
        country: 'IN',
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    const brand = await prisma.brand.create({ data: { tenantId, name } })
    const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: `${name} Outlet`, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    const role = await prisma.role.create({ data: { tenantId, name: 'Cashier', isSystem: true, isManager: false } })
    const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: `${name} Cashier`, pinHash: await argon2.hash(HUB_PIN), pinIssuedAt: new Date() } })
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `${name} Dosa`, shortName: 'Dosa' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 12000n, currency: 'INR', channel: 'dine_in' } })
    return { tenantId, outletId: outlet.id, staffId: staff.id, itemId: item.id }
  } finally {
    await pg.exec(`SET ROLE ${APP_ROLE}`)
  }
}
