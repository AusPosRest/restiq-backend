// Seeds realistic CAP-7 dead-letter rows for local verification. Revocation
// is the only current writer into sync_dead_letters (device fleet routes a
// revoked device's queued ops there) and no real sync engine exists yet to
// keep the queue populated, so this backfills a believable mix of reason
// codes against a fixed demo tenant/outlet/devices.
// Idempotent: reuses the demo tenant/outlet/devices if present, skips a
// fixture whose op_id already exists.
//
//   pnpm run seed:dlq
import 'dotenv/config'
import { createPrismaClient } from '../src/db/client'
import type { Prisma } from '../src/generated/prisma/client'
import { uuidv7 } from '../src/platform'

const TENANT_NAME = 'DLQ Demo Hospitality'

interface DeadLetterFixture {
  opId: string
  deviceLabel: string
  deviceType: 'pos' | 'kds' | 'kiosk' | 'cds'
  reasonCode: string
  reasonText: string
  payloadMeta: Prisma.InputJsonValue
}

// A believable spread across the reason-code shape story 4 established
// (`device_revoked`, written by the revoke path) plus the sync-rejection
// codes CAP-7 triages: clock skew, a stale menu/price version, and a
// non-recoverable schema mismatch (this build's rejected-again case).
const FIXTURES: DeadLetterFixture[] = [
  {
    opId: '00000000-0000-7000-8000-00000000d001',
    deviceLabel: 'Front Counter POS',
    deviceType: 'pos',
    reasonCode: 'clock_skew',
    reasonText: 'Clock skew exceeds 120s - device clock is 4m ahead',
    payloadMeta: { kind: 'order.sync' },
  },
  {
    opId: '00000000-0000-7000-8000-00000000d002',
    deviceLabel: 'Kitchen KDS',
    deviceType: 'kds',
    reasonCode: 'stale_price_version',
    reasonText: 'Order priced against a menu version the server has since superseded',
    payloadMeta: { kind: 'order.sync' },
  },
  {
    opId: '00000000-0000-7000-8000-00000000d003',
    deviceLabel: 'Drive-thru Kiosk',
    deviceType: 'kiosk',
    reasonCode: 'schema_skew',
    reasonText: 'Device app version is too old to sync the current op schema',
    payloadMeta: { kind: 'order.sync' },
  },
  {
    opId: '00000000-0000-7000-8000-00000000d004',
    deviceLabel: 'Patio Terminal',
    deviceType: 'pos',
    reasonCode: 'device_revoked',
    reasonText: 'Device was revoked while an op was in flight',
    payloadMeta: { kind: 'order.sync' },
  },
  {
    opId: '00000000-0000-7000-8000-00000000d005',
    deviceLabel: 'Front Counter POS',
    deviceType: 'pos',
    reasonCode: 'clock_skew',
    reasonText: 'Clock skew exceeds 120s - device clock is 9m behind',
    payloadMeta: { kind: 'order.sync' },
  },
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
          contactEmail: 'dlq-demo@restiq.example',
          contactPhone: '+91 90000 00002',
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
      data: { tenantId: tenant.id, brandId: brand.id, name: 'Koramangala Central', address: '200 Sarjapur Road', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })

    for (const fixture of FIXTURES) {
      const already = await prisma.syncDeadLetter.findFirst({ where: { opId: fixture.opId } })
      if (already) {
        console.log(`skipped (already seeded): ${fixture.reasonCode} for ${fixture.deviceLabel}`)
        continue
      }

      let device = await prisma.device.findFirst({ where: { tenantId: tenant.id, label: fixture.deviceLabel } })
      device ??= await prisma.device.create({
        data: {
          id: uuidv7(),
          tenantId: tenant.id,
          outletId: outlet.id,
          label: fixture.deviceLabel,
          type: fixture.deviceType,
          hardwareKeyFingerprint: `demo-fp-${fixture.deviceLabel}`,
          enrolledAt: new Date(),
        },
      })

      const row = await prisma.syncDeadLetter.create({
        data: {
          tenantId: tenant.id,
          deviceId: device.id,
          opId: fixture.opId,
          reasonCode: fixture.reasonCode,
          reasonText: fixture.reasonText,
          payloadMeta: fixture.payloadMeta,
        },
      })
      console.log(`dead letter seeded: ${fixture.reasonCode} on ${fixture.deviceLabel} (${row.id})`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
