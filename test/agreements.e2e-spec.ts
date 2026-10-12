// Issue #132, PDF rework #179: operators publish immutable numbered agreement versions as an
// uploaded PDF; a tenant owner reads the PDF and signs only the current one, once, against the
// hash of the file they were shown; ops reads the standing per tenant; a tenant never sees
// another tenant's signature.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'agreements-operator@restiq.example'

interface VersionBody {
  version: { id: string; version: number; title: string; hasFile: boolean; fileName: string | null; sizeBytes: number | null; fileSha256: string; publishedBy: string; signatureCount: number }
}
interface OwnerBody {
  current: { id: string; version: number; title: string; hasFile: boolean; fileName: string | null; sizeBytes: number | null; fileSha256: string } | null
  signature: { signerName: string; signerEmail: string; signedAt: string; evidenceSha256: string; version: number } | null
  history: Array<{ version: number; signerName: string }>
}
interface ErrorBody {
  error: { code: string; message: string }
}

async function createOwner(prisma: PrismaClient, name: string): Promise<{ tenantId: string; ownerId: string; email: string; token: string }> {
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
  const ownerId = uuidv7()
  const email = `owner-${tenantId}@test.example`
  return { tenantId, ownerId, email, token: signAdminToken({ id: ownerId, tenantId, email }) }
}

// A minimal but real PDF; the second one differs only in its text, so its hash differs.
function pdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1')
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('agreements (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await prisma.agreementSignature.deleteMany()
    await prisma.agreementVersion.deleteMany()
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.agreementSignature.deleteMany()
    await prisma.agreementVersion.deleteMany()
    await prisma.controlPlaneAuditEvent.deleteMany({ where: { action: 'agreement.published' } })
  })

  function publish(title: string, text: string) {
    return request(httpServer)
      .post('/ops/v1/agreements')
      .set('Authorization', `Bearer ${opsToken}`)
      .field('title', title)
      .field('reason', 'Legal refresh')
      .attach('file', pdf(text), { filename: `${title}.pdf`, contentType: 'application/pdf' })
  }

  it('publishes gap-free versions, hashes the file, audits with the reason, and lists newest first', async () => {
    const first = await publish('Terms v1', 'Body one').expect(201)
    const second = await publish('Terms v2', 'Body two').expect(201)
    expect((first.body as VersionBody).version.version).toBe(1)
    expect((second.body as VersionBody).version.version).toBe(2)
    expect((second.body as VersionBody).version).toMatchObject({ hasFile: true, fileName: 'Terms v2.pdf', sizeBytes: pdf('Body two').length, fileSha256: sha(pdf('Body two')) })
    expect(JSON.stringify(second.body)).not.toContain('"body"')
    expect((second.body as VersionBody).version.publishedBy).toBe(OPERATOR_EMAIL)

    const list = await request(httpServer).get('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect((list.body as { versions: Array<{ version: number; signatureCount: number }> }).versions.map((v) => v.version)).toEqual([2, 1])

    const audit = await prisma.controlPlaneAuditEvent.findFirst({ where: { action: 'agreement.published' }, orderBy: { recordedAt: 'desc' } })
    expect(audit?.actorEmail).toBe(OPERATOR_EMAIL)
    expect(audit?.reason).toContain('Legal refresh')

    await request(httpServer).post('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).field('title', 'x').attach('file', pdf('y'), 'x.pdf').expect(400) // no reason
    await request(httpServer).get(`/ops/v1/agreements/${uuidv7()}`).set('Authorization', `Bearer ${opsToken}`).expect(404)
  })

  it('owner signs the current version once; a stale version and a repeat sign are 409; ops sees the standing', async () => {
    const owner = await createOwner(prisma, 'Signing Tenant')
    const v1 = ((await publish('Terms v1', 'Body one').expect(201)).body as VersionBody).version

    const before = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${owner.token}`).expect(200)).body as OwnerBody
    expect(before.current?.id).toBe(v1.id)
    expect(before.current).toMatchObject({ hasFile: true, fileSha256: v1.fileSha256 })
    expect(before.signature).toBeNull()

    const pending = await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(pending.body).toMatchObject({ status: 'pending', signatures: [] })

    // accepted must be literally true and the name non-empty.
    await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha Rao', accepted: false, fileSha256: v1.fileSha256 }).expect(400)
    await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: '  ', accepted: true, fileSha256: v1.fileSha256 }).expect(400)
    await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha Rao', accepted: true }).expect(400) // must say which file was read

    const signed = await request(httpServer)
      .post(`/admin/v1/agreement/${v1.id}/sign`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ signerName: '  Asha Rao ', accepted: true, fileSha256: v1.fileSha256 })
      .expect(201)
    const signature = (signed.body as { signature: OwnerBody['signature'] }).signature
    expect(signature).toMatchObject({ signerName: 'Asha Rao', signerEmail: owner.email, version: 1 })
    expect(signature?.evidenceSha256).toBe(
      createHash('sha256').update([v1.fileSha256, owner.tenantId, owner.ownerId, owner.email, 'Asha Rao', signature?.signedAt].join('\n')).digest('hex'),
    )

    const repeat = await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha Rao', accepted: true, fileSha256: v1.fileSha256 }).expect(409)
    expect((repeat.body as ErrorBody).error.code).toBe('already_signed')

    const after = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${owner.token}`).expect(200)).body as OwnerBody
    expect(after.signature?.signerName).toBe('Asha Rao')
    expect(after.history.map((h) => h.version)).toEqual([1])

    const audit = await prisma.auditEvent.findFirst({ where: { tenantId: owner.tenantId, action: 'agreement.signed' } })
    expect(audit?.actorEmail).toBe(owner.email)

    // A new version re-opens signing; the old one can no longer be signed.
    const v2 = ((await publish('Terms v2', 'Body two').expect(201)).body as VersionBody).version
    const reopened = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${owner.token}`).expect(200)).body as OwnerBody
    expect(reopened.current?.id).toBe(v2.id)
    expect(reopened.signature).toBeNull()
    expect(reopened.history.map((h) => h.version)).toEqual([1])

    const stale = await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha Rao', accepted: true, fileSha256: v1.fileSha256 }).expect(409)
    expect((stale.body as ErrorBody).error.code).toBe('stale_version')
    await request(httpServer).post(`/admin/v1/agreement/${uuidv7()}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha Rao', accepted: true, fileSha256: v1.fileSha256 }).expect(404)

    const standing = await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(standing.body).toMatchObject({ status: 'pending', current: { id: v2.id, version: 2 } })
    expect((standing.body as { signatures: Array<{ version: number; signerName: string }> }).signatures).toEqual([expect.objectContaining({ version: 1, signerName: 'Asha Rao' })])
    const listed = (await request(httpServer).get('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as { versions: Array<{ version: number; signatureCount: number }> }
    expect(listed.versions.find((v) => v.version === 1)?.signatureCount).toBe(1)
  })

  it('a tenant never sees another tenant\'s signature; no version at all is reported as such', async () => {
    const a = await createOwner(prisma, 'Tenant A')
    const b = await createOwner(prisma, 'Tenant B')

    const none = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${a.token}`).expect(200)).body as OwnerBody
    expect(none).toEqual({ current: null, signature: null, history: [] })
    const opsNone = await request(httpServer).get(`/ops/v1/tenants/${a.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(opsNone.body).toMatchObject({ status: 'no_agreement', current: null })
    await request(httpServer).post(`/admin/v1/agreement/${uuidv7()}/sign`).set('Authorization', `Bearer ${a.token}`).send({ signerName: 'A', accepted: true, fileSha256: 'a'.repeat(64) }).expect(404)

    const v1 = ((await publish('Terms v1', 'Body one').expect(201)).body as VersionBody).version
    await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${a.token}`).send({ signerName: 'Owner A', accepted: true, fileSha256: v1.fileSha256 }).expect(201)

    const seenByB = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${b.token}`).expect(200)).body as OwnerBody
    expect(seenByB.signature).toBeNull()
    expect(seenByB.history).toEqual([])
    await request(httpServer).post(`/admin/v1/agreement/${v1.id}/sign`).set('Authorization', `Bearer ${b.token}`).send({ signerName: 'Owner B', accepted: true, fileSha256: v1.fileSha256 }).expect(201)

    await request(httpServer).get('/ops/v1/agreements').expect(401)
    await request(httpServer).get('/admin/v1/agreement').expect(401)
    await request(httpServer).get(`/ops/v1/tenants/${uuidv7()}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(404)
  })

  it('refuses anything that is not a PDF, an empty file, a missing file, and a file over 5 MB', async () => {
    const post = () => request(httpServer).post('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).field('title', 'Terms').field('reason', 'Legal refresh')
    expect(((await post().attach('file', Buffer.from('just some text'), { filename: 'terms.pdf', contentType: 'application/pdf' }).expect(400)).body as ErrorBody).error.code).toBe('invalid_file')
    expect(((await post().attach('file', Buffer.from('PK\u0003\u0004zip'), { filename: 'terms.pdf', contentType: 'application/pdf' }).expect(400)).body as ErrorBody).error.code).toBe('invalid_file')
    expect(((await post().attach('file', Buffer.alloc(0), { filename: 'terms.pdf', contentType: 'application/pdf' }).expect(400)).body as ErrorBody).error.code).toMatch(/invalid_file|file_required/)
    expect(((await post().expect(400)).body as ErrorBody).error.code).toBe('file_required')
    await post().attach('file', Buffer.concat([pdf('big'), Buffer.alloc(5 * 1024 * 1024)]), { filename: 'big.pdf', contentType: 'application/pdf' }).expect(413)
    expect(await prisma.agreementVersion.count()).toBe(0)
  })

  it('serves the exact PDF inline to ops and to an owner, and 404s a missing version or a legacy text version', async () => {
    const owner = await createOwner(prisma, 'Reader')
    const bytes = pdf('Read me')
    const v1 = ((await publish('Terms v1', 'Read me').expect(201)).body as VersionBody).version

    const fromOps = await request(httpServer).get(`/ops/v1/agreements/${v1.id}/file`).set('Authorization', `Bearer ${opsToken}`).buffer().parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))) }).expect(200)
    expect(fromOps.headers['content-type']).toContain('application/pdf')
    expect(fromOps.headers['content-disposition']).toBe('inline; filename="Terms v1.pdf"')
    expect(fromOps.headers['x-content-type-options']).toBe('nosniff')
    expect(sha(fromOps.body as Buffer)).toBe(sha(bytes))

    const fromOwner = await request(httpServer).get(`/admin/v1/agreement/${v1.id}/file`).set('Authorization', `Bearer ${owner.token}`).buffer().parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))) }).expect(200)
    expect(sha(fromOwner.body as Buffer)).toBe(sha(bytes))
    await request(httpServer).get(`/admin/v1/agreement/${v1.id}/file`).expect(401)
    await request(httpServer).get(`/admin/v1/agreement/${uuidv7()}/file`).set('Authorization', `Bearer ${owner.token}`).expect(404)

    // A version published as text before the rework has no file and cannot be signed until ops publishes a new one.
    const legacy = await prisma.agreementVersion.create({ data: { version: 99, title: 'Old terms', body: 'Plain text', fileSha256: sha(Buffer.from('Plain text')), publishedBy: 'ops@restiq.example' } })
    const legacyFile = await request(httpServer).get(`/admin/v1/agreement/${legacy.id}/file`).set('Authorization', `Bearer ${owner.token}`).expect(404)
    expect((legacyFile.body as ErrorBody).error.code).toBe('no_file')
    const view = (await request(httpServer).get('/admin/v1/agreement').set('Authorization', `Bearer ${owner.token}`).expect(200)).body as OwnerBody
    expect(view.current).toMatchObject({ id: legacy.id, hasFile: false, fileName: null })
    expect(JSON.stringify(view)).not.toContain('Plain text')
    const refused = await request(httpServer).post(`/admin/v1/agreement/${legacy.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha', accepted: true, fileSha256: legacy.fileSha256 }).expect(409)
    expect((refused.body as ErrorBody).error.code).toBe('no_file')
  })

  it('signing needs the hash of the file the owner read: a different hash is 409 file_changed and records nothing', async () => {
    const owner = await createOwner(prisma, 'Careful Reader')
    await publish('Terms v1', 'First text').expect(201)
    const v2 = ((await publish('Terms v1 corrected', 'Second text').expect(201)).body as VersionBody).version

    const seenEarlier = sha(pdf('First text'))
    const res = await request(httpServer).post(`/admin/v1/agreement/${v2.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha', accepted: true, fileSha256: seenEarlier }).expect(409)
    expect((res.body as ErrorBody).error.code).toBe('file_changed')
    expect(await prisma.agreementSignature.count({ where: { tenantId: owner.tenantId } })).toBe(0)

    const ok = await request(httpServer).post(`/admin/v1/agreement/${v2.id}/sign`).set('Authorization', `Bearer ${owner.token}`).send({ signerName: 'Asha', accepted: true, fileSha256: v2.fileSha256 }).expect(201)
    expect((ok.body as { signature: { version: number } }).signature.version).toBe(2)
  })
})
