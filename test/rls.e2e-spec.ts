// AD-5 / NFR-8: forced RLS on tenant-owned tables, proven through a
// NON-superuser connection (the app's own superuser bypasses RLS locally, so
// this suite provisions a restricted probe role and connects as it).
// The wrong-tenant-context test asserts zero rows.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { uuidv7 } from '../src/platform'

const PROBE_ROLE = 'restiq_rls_probe'
const PROBE_PASSWORD = 'rls-probe-only'

function probeUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string)
  url.username = PROBE_ROLE
  url.password = PROBE_PASSWORD
  return url.toString()
}

describe('row-level security on region-plane tables (e2e)', () => {
  let admin: PrismaClient
  let probe: PrismaClient
  let tenantId: string

  beforeAll(async () => {
    admin = createPrismaClient()
    await admin.$executeRawUnsafe(`
      DO $$ BEGIN
        CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}';
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `)
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`)
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`)

    // Seed one tenant directly (as superuser, which bypasses RLS by design).
    tenantId = uuidv7()
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'RLS Probe Tenant',
        registeredAddress: 'x',
        contactName: 'x',
        contactEmail: 'rls@probe.example',
        contactPhone: 'x',
        country: 'IN',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    await admin.auditEvent.create({
      data: {
        tenantId,
        actorEmail: 'rls@probe.example',
        action: 'rls.probe',
        reason: 'rls test fixture',
        occurredAt: new Date(),
      },
    })

    probe = createPrismaClient(probeUrl())
  })

  afterAll(async () => {
    await probe.$disconnect()
    await admin.auditEvent.deleteMany({ where: { tenantId } })
    await admin.tenant.delete({ where: { id: tenantId } })
    await admin.$disconnect()
  })

  it('returns zero rows with no tenant context (fail closed)', async () => {
    expect(await probe.tenant.count()).toBe(0)
  })

  it('returns zero rows under the WRONG tenant context', async () => {
    const rows = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`
      return tx.tenant.count()
    })
    expect(rows).toBe(0)
  })

  it('returns the tenant row under the correct tenant context', async () => {
    const rows = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.tenant.count({ where: { id: tenantId } })
    })
    expect(rows).toBe(1)
  })

  it('blocks INSERTs whose tenant_id does not match the context', async () => {
    await expect(
      probe.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`
        await tx.brand.create({ data: { tenantId, name: 'Smuggled Brand' } })
      }),
    ).rejects.toThrow()
    expect(await admin.brand.count({ where: { tenantId } })).toBe(0)
  })

  it('reads cross-tenant under the explicit operator context', async () => {
    const rows = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      return tx.tenant.count()
    })
    expect(rows).toBeGreaterThanOrEqual(1)
  })

  it('owner_invites: fails closed under tenant context, reads cross-tenant under the invite-accept context (AD-10/CAP-1)', async () => {
    await admin.ownerInvite.create({
      data: {
        tenantId,
        email: 'probe-owner@test.example',
        firstName: 'Probe',
        lastName: 'Owner',
        tokenHash: 'rls-probe-token-hash',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })

    const underWrongTenant = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`
      return tx.ownerInvite.count()
    })
    expect(underWrongTenant).toBe(0)

    // The accept-invite flow authenticates by possession of the raw token,
    // before any tenant_id is known - this context is what makes that lookup
    // possible without disabling RLS.
    const underInviteContext = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.invite_accept_context', 'invite', true)`
      return tx.ownerInvite.count({ where: { tenantId } })
    })
    expect(underInviteContext).toBe(1)

    await admin.ownerInvite.deleteMany({ where: { tenantId } })
  })

  it('keeps audit_events append-only: UPDATE and DELETE touch zero rows even in-context', async () => {
    const updated = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.auditEvent.updateMany({ where: { tenantId }, data: { reason: 'tampered' } })
    })
    expect(updated.count).toBe(0)

    const deleted = await probe.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.auditEvent.deleteMany({ where: { tenantId } })
    })
    expect(deleted.count).toBe(0)

    expect(await admin.auditEvent.count({ where: { tenantId, reason: 'rls test fixture' } })).toBe(1)
  })
})
