// Seeds/backfills realistic CAP-6 heartbeat data for local verification.
// Idempotent: reuses a fixed demo tenant/outlet if they already exist and
// only creates devices that are missing, but always refreshes heartbeat
// fields so a rerun still shows a live spread of severities (healthy,
// lagging, one deliberately >48h silent, one that has never checked in).
//
//   pnpm run seed:sync-health
import 'dotenv/config'
import { createPrismaClient } from '../src/db/client'
import { uuidv7 } from '../src/platform'

const TENANT_NAME = 'Sync Health Demo'
const HOUR_MS = 60 * 60 * 1000

interface HeartbeatFixture {
  label: string
  type: 'pos' | 'kds' | 'kiosk' | 'cds'
  hoursSinceContact: number | null // null = never sent a heartbeat
  outboxDepth: number
  appVersion: string
  clockSkewSeconds: number
  recentRejectionCount: number
}

const FIXTURES: HeartbeatFixture[] = [
  { label: 'Front Counter POS', type: 'pos', hoursSinceContact: 0.05, outboxDepth: 0, appVersion: '2.4.1', clockSkewSeconds: 1, recentRejectionCount: 0 },
  { label: 'Kitchen KDS', type: 'kds', hoursSinceContact: 0.2, outboxDepth: 2, appVersion: '2.4.1', clockSkewSeconds: -1, recentRejectionCount: 0 },
  { label: 'Drive-thru Kiosk', type: 'kiosk', hoursSinceContact: 2.5, outboxDepth: 34, appVersion: '2.3.9', clockSkewSeconds: 8, recentRejectionCount: 2 },
  { label: 'Patio Customer Display', type: 'cds', hoursSinceContact: 50, outboxDepth: 412, appVersion: '2.2.0', clockSkewSeconds: 128, recentRejectionCount: 9 },
  { label: 'Storeroom Terminal', type: 'pos', hoursSinceContact: null, outboxDepth: 0, appVersion: '2.4.1', clockSkewSeconds: 0, recentRejectionCount: 0 },
]

async function main(): Promise<void> {
  const prisma = createPrismaClient()
  try {
    let tenant = await prisma.tenant.findFirst({ where: { name: TENANT_NAME } })
    if (!tenant) {
      const tenantId = uuidv7()
      await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
      tenant = await prisma.tenant.create({
        data: {
          id: tenantId,
          name: TENANT_NAME,
          registeredAddress: '1 Demo Street, Bengaluru',
          contactName: 'Demo Contact',
          contactEmail: 'demo@restiq.example',
          contactPhone: '+91 90000 00001',
          country: 'IN',
          status: 'active',
          plan: 'standard',
          billingPeriod: 'monthly',
        },
      })
      console.log(`created demo tenant: ${tenant.name} (${tenant.id})`)
    }

    let brand = await prisma.brand.findFirst({ where: { tenantId: tenant.id } })
    brand ??= await prisma.brand.create({ data: { tenantId: tenant.id, name: TENANT_NAME } })

    let outlet = await prisma.outlet.findFirst({ where: { tenantId: tenant.id } })
    outlet ??= await prisma.outlet.create({
      data: { tenantId: tenant.id, brandId: brand.id, name: 'Indiranagar Central', address: '100 MG Road', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })

    for (const fixture of FIXTURES) {
      let device = await prisma.device.findFirst({ where: { tenantId: tenant.id, label: fixture.label } })
      device ??= await prisma.device.create({
        data: {
          id: uuidv7(),
          tenantId: tenant.id,
          outletId: outlet.id,
          label: fixture.label,
          type: fixture.type,
          hardwareKeyFingerprint: `demo-fp-${fixture.label}`,
          enrolledAt: new Date(Date.now() - 200 * HOUR_MS),
        },
      })

      await prisma.device.update({
        where: { id: device.id },
        data: {
          lastContactAt: fixture.hoursSinceContact === null ? null : new Date(Date.now() - fixture.hoursSinceContact * HOUR_MS),
          outboxDepth: fixture.outboxDepth,
          appVersion: fixture.appVersion,
          clockSkewSeconds: fixture.clockSkewSeconds,
          recentRejectionCount: fixture.recentRejectionCount,
        },
      })
      console.log(`heartbeat seeded: ${fixture.label} (${device.id})`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
