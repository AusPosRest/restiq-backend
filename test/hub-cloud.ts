// The real cloud for hub e2e specs (#304, #310): the cloud Nest app on its own
// Prisma client (Postgres) on an ephemeral port, a hub device enrolled in it,
// and the cleanup of everything a hub sale leaves in the cloud. The hub runs
// on PGlite in the same process (setPrismaClient is the hub's client).
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppModule } from '../src/app.module'
import { createPrismaClient, type PrismaClient } from '../src/db/client'
import { devicePrivateKey } from '../src/hub/signer'
import { PrismaService, uuidv7 } from '../src/platform'
import type { SaleFixture } from './hub-seed'

export type Row = Record<string, unknown>

export interface Cloud {
  prisma: PrismaClient
  app: INestApplication
  url: string
  /** Closes the port: the hub is cut off from the internet. */
  down(): Promise<void>
  /** Listens on the same port again. */
  up(): Promise<void>
}

export async function startCloud(): Promise<Cloud> {
  const prisma = createPrismaClient()
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({ client: prisma, onModuleDestroy: () => Promise.resolve() })
    .compile()
  // rawBody, as main.ts: the device signature covers the exact bytes.
  const app = moduleRef.createNestApplication({ rawBody: true })
  await app.listen(0, '127.0.0.1')
  const server = app.getHttpServer() as Server
  const { port } = server.address() as AddressInfo
  return {
    prisma,
    app,
    url: `http://127.0.0.1:${port}`,
    down: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
    up: () => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
  }
}

/** An enrolled hub device for the fixture's outlet, and its private key. */
export async function enrolHub(cloud: PrismaClient, f: SaleFixture): Promise<{ deviceId: string; key: KeyObject }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const device = await cloud.device.create({
    data: {
      tenantId: f.tenantId,
      outletId: f.outletId,
      label: 'Hub',
      type: 'pos',
      role: 'hub',
      hardwareKeyFingerprint: `hub-${uuidv7()}`,
      enrolledAt: new Date(),
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    },
  })
  return { deviceId: device.id, key: devicePrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()) }
}

/** Changes become visible to pull once settled (30 s); age them. */
export function settle(cloud: PrismaClient, tenantId: string) {
  return cloud.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute' WHERE tenant_id = ${tenantId}::uuid`
}

/** Reads on the hub as superuser, past RLS. */
export function hubRows(hub: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return hub.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE')
    return (await tx.query<Row>(sql, params)).rows
  })
}

/** Deletes the tenant and everything hub sales and the sale fixture made in the cloud. */
export async function deleteCloudTenant(cloud: PrismaClient, tenantId: string, deviceId: string | undefined): Promise<void> {
  const where = { tenantId }
  if (deviceId) await cloud.appliedOp.deleteMany({ where: { deviceId } })
  await cloud.syncDeadLetter.deleteMany({ where })
  await cloud.tender.deleteMany({ where })
  await cloud.bill.deleteMany({ where })
  await cloud.billNumberCounter.deleteMany({ where })
  await cloud.tokenNumberCounter.deleteMany({ where })
  await cloud.ticketLine.deleteMany({ where })
  await cloud.ticketEvent.deleteMany({ where })
  await cloud.ticket.deleteMany({ where })
  await cloud.orderLineModifier.deleteMany({ where })
  await cloud.orderLine.deleteMany({ where: { ...where, parentLineId: { not: null } } })
  await cloud.orderLine.deleteMany({ where })
  await cloud.order.deleteMany({ where })
  await cloud.cashMovement.deleteMany({ where })
  await cloud.shift.deleteMany({ where })
  await cloud.clockEvent.deleteMany({ where })
  await cloud.auditEvent.deleteMany({ where })
  await cloud.device.deleteMany({ where })
  await cloud.staffUser.deleteMany({ where })
  await cloud.role.deleteMany({ where })
  await cloud.comboSlotOption.deleteMany({ where })
  await cloud.comboSlot.deleteMany({ where })
  await cloud.combo.deleteMany({ where })
  await cloud.itemModifierGroup.deleteMany({ where })
  await cloud.modifier.deleteMany({ where })
  await cloud.modifierGroup.deleteMany({ where })
  await cloud.itemPrice.deleteMany({ where })
  await cloud.menuItem.deleteMany({ where })
  await cloud.menuCategory.deleteMany({ where })
  await cloud.station.deleteMany({ where })
  await cloud.diningTable.deleteMany({ where })
  await cloud.floor.deleteMany({ where })
  await cloud.outlet.deleteMany({ where })
  await cloud.brand.deleteMany({ where })
  await cloud.syncChange.deleteMany({ where })
  await cloud.tenant.deleteMany({ where: { id: tenantId } })
  await cloud.tenantRegistryEntry.deleteMany({ where })
}
