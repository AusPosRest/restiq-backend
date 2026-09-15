// Issues #132/#150: operators publish immutable numbered agreement versions;
// a tenant owner signs the current one through DocuSign (embedded) and the
// platform countersigns; the completed, sealed PDF is stored and
// downloadable; ops reads the standing per tenant; a tenant never sees
// another tenant's signature. DocuSign itself is an in-memory fake here - its
// HTTP contract is covered by src/ops/agreements/docusign.client.spec.ts.
import { INestApplication, ServiceUnavailableException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { DocuSignClient } from '../src/ops'
import type { EnvelopeSigner, EnvelopeState } from '../src/ops'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'agreements-operator@restiq.example'
const WEB_ORIGIN = 'https://web.restiq.test'

class FakeDocuSign {
  configured = true
  envelopes = new Map<string, { html: string; signer: EnvelopeSigner; state: EnvelopeState }>()

  config() {
    if (!this.configured) throw new ServiceUnavailableException({ code: 'esign_unavailable', message: 'Electronic signing is not set up yet. Contact Restiq support.' })
    return { countersigner: { name: 'Priya Menon', email: 'legal@restiq.example', title: 'Director' } }
  }

  createEnvelope(input: { html: string; signer: EnvelopeSigner }): Promise<string> {
    this.config()
    const id = `env-${this.envelopes.size + 1}`
    this.envelopes.set(id, { html: input.html, signer: input.signer, state: { status: 'sent', ownerSignedAt: null, completedAt: null } })
    return Promise.resolve(id)
  }

  signingUrl(envelopeId: string, signer: EnvelopeSigner, returnUrl: string): Promise<string> {
    return Promise.resolve(`https://demo.docusign.test/signing/${envelopeId}?as=${signer.clientUserId}&returnUrl=${encodeURIComponent(returnUrl)}`)
  }

  envelopeState(envelopeId: string): Promise<EnvelopeState> {
    const envelope = this.envelopes.get(envelopeId)
    return envelope ? Promise.resolve(envelope.state) : Promise.reject(new Error(`unknown envelope ${envelopeId}`))
  }

  completedPdf(envelopeId: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(`%PDF-1.7 sealed ${envelopeId}`))
  }

  update(envelopeId: string, state: Partial<EnvelopeState>): void {
    const envelope = this.envelopes.get(envelopeId)
    if (envelope) envelope.state = { ...envelope.state, ...state }
  }
}

interface VersionBody {
  version: { id: string; version: number; title: string; body: string; bodySha256: string; publishedBy: string; signatureCount: number }
}
interface SignatureBody {
  version: number
  signerName: string
  signerEmail: string
  signerTitle: string | null
  signedAt: string
  evidenceSha256: string
  hasPdf: boolean
}
interface OwnerBody {
  current: { id: string; version: number; title: string; body: string } | null
  signature: SignatureBody | null
  signing: { status: string; signerName: string; signerTitle: string; ownerSignedAt: string | null } | null
  history: SignatureBody[]
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
      registeredAddress: '1 Test Street, Bengaluru',
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

describe('agreements (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string
  let docusign: FakeDocuSign

  beforeAll(async () => {
    process.env.WEB_ORIGIN = WEB_ORIGIN
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })

    docusign = new FakeDocuSign()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DocuSignClient)
      .useValue(docusign)
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await prisma.agreementSignature.deleteMany()
    await prisma.agreementEnvelope.deleteMany()
    await prisma.agreementVersion.deleteMany()
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.agreementSignature.deleteMany()
    await prisma.agreementEnvelope.deleteMany()
    await prisma.agreementVersion.deleteMany()
    await prisma.controlPlaneAuditEvent.deleteMany({ where: { action: 'agreement.published' } })
    docusign.configured = true
    docusign.envelopes.clear()
  })

  function publish(title: string, body: string) {
    return request(httpServer)
      .post('/ops/v1/agreements')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ title, body, reason: 'Legal refresh' })
  }

  function ownerView(token: string): Promise<OwnerBody> {
    return request(httpServer)
      .get('/admin/v1/agreement')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .then((res) => res.body as OwnerBody)
  }

  function startSigning(token: string, versionId: string, body: object = { signerName: '  Asha Rao ', signerTitle: 'Director' }) {
    return request(httpServer).post(`/admin/v1/agreement/${versionId}/signing`).set('Authorization', `Bearer ${token}`).send(body)
  }

  it('publishes gap-free versions, hashes the body, audits with the reason, and lists newest first', async () => {
    const first = await publish('Terms v1', 'Body one').expect(201)
    const second = await publish('Terms v2', 'Body two').expect(201)
    expect((first.body as VersionBody).version.version).toBe(1)
    expect((second.body as VersionBody).version.version).toBe(2)
    expect((second.body as VersionBody).version.bodySha256).toBe(createHash('sha256').update('Body two').digest('hex'))
    expect((second.body as VersionBody).version.publishedBy).toBe(OPERATOR_EMAIL)

    const list = await request(httpServer).get('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect((list.body as { versions: Array<{ version: number; signatureCount: number }> }).versions.map((v) => v.version)).toEqual([2, 1])

    const audit = await prisma.controlPlaneAuditEvent.findFirst({ where: { action: 'agreement.published' }, orderBy: { recordedAt: 'desc' } })
    expect(audit?.actorEmail).toBe(OPERATOR_EMAIL)
    expect(audit?.reason).toContain('Legal refresh')

    await request(httpServer).post('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).send({ title: 'x', body: 'y' }).expect(400)
    await request(httpServer).get(`/ops/v1/agreements/${uuidv7()}`).set('Authorization', `Bearer ${opsToken}`).expect(404)
  })

  it('owner signs in DocuSign, Restiq countersigns, and the sealed PDF is stored and downloadable', async () => {
    const owner = await createOwner(prisma, 'Signing Tenant')
    const v1 = ((await publish('Terms v1', '# 1. Parties\nThis is between Restiq and {{customer.legalName}} of {{customer.address}}, {{customer.country}}.').expect(201)).body as VersionBody)
      .version

    const before = await ownerView(owner.token)
    expect(before.current?.id).toBe(v1.id)
    expect(before.current?.body).toBe('# 1. Parties\nThis is between Restiq and Signing Tenant of 1 Test Street, Bengaluru, India.')
    expect(before).toMatchObject({ signature: null, signing: null })
    const pending = await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(pending.body).toMatchObject({ status: 'pending', signatures: [] })

    // Name and title are both required and must not be blank.
    await startSigning(owner.token, v1.id, { signerName: 'Asha Rao' }).expect(400)
    await startSigning(owner.token, v1.id, { signerName: 'Asha Rao', signerTitle: '   ' }).expect(400)

    const started = await startSigning(owner.token, v1.id).expect(201)
    expect((started.body as { url: string }).url).toBe(
      `https://demo.docusign.test/signing/env-1?as=${owner.ownerId}&returnUrl=${encodeURIComponent(`${WEB_ORIGIN}/admin/settings/agreement`)}`,
    )
    const sent = docusign.envelopes.get('env-1')
    expect(sent?.signer).toEqual({ name: 'Asha Rao', email: owner.email, clientUserId: owner.ownerId })
    expect(sent?.html).toContain('This is between Restiq and Signing Tenant of 1 Test Street, Bengaluru, India.')
    expect(sent?.html).toContain('Name: Asha Rao<br>Title: Director')
    expect(sent?.html).toContain('Name: Priya Menon<br>Title: Director')
    expect((await ownerView(owner.token)).signing).toMatchObject({ status: 'awaiting_owner', signerName: 'Asha Rao', signerTitle: 'Director' })

    // Coming back to it resumes the same envelope rather than sending a second one.
    await startSigning(owner.token, v1.id).expect(201)
    expect(docusign.envelopes.size).toBe(1)
    expect(await prisma.auditEvent.count({ where: { tenantId: owner.tenantId, action: 'agreement.signing_started' } })).toBe(1)

    // The owner signs; Restiq has not countersigned yet.
    docusign.update('env-1', { ownerSignedAt: new Date('2026-09-15T10:00:00Z') })
    const awaiting = await ownerView(owner.token)
    expect(awaiting.signing).toMatchObject({ status: 'awaiting_countersign', ownerSignedAt: '2026-09-15T10:00:00.000Z' })
    expect(awaiting.signature).toBeNull()
    const standing = await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect((standing.body as { status: string }).status).toBe('awaiting_countersign')
    expect(((await startSigning(owner.token, v1.id).expect(409)).body as ErrorBody).error.code).toBe('awaiting_countersign')
    await request(httpServer).get(`/admin/v1/agreement/${v1.id}/pdf`).set('Authorization', `Bearer ${owner.token}`).expect(404)

    // Restiq countersigns: the envelope completes and the sealed PDF is stored with the signature.
    docusign.update('env-1', { status: 'completed', completedAt: new Date('2026-09-15T11:00:00Z') })
    const signed = await ownerView(owner.token)
    const pdf = Buffer.from('%PDF-1.7 sealed env-1')
    expect(signed.signing).toBeNull()
    expect(signed.signature).toMatchObject({
      version: 1,
      signerName: 'Asha Rao',
      signerTitle: 'Director',
      signerEmail: owner.email,
      signedAt: '2026-09-15T10:00:00.000Z',
      evidenceSha256: createHash('sha256').update(pdf).digest('hex'),
      hasPdf: true,
    })
    expect(signed.history.map((h) => h.version)).toEqual([1])
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId: owner.tenantId, action: 'agreement.signed' } })
    expect(audit?.reason).toContain('env-1')

    const download = await request(httpServer).get(`/admin/v1/agreement/${v1.id}/pdf`).set('Authorization', `Bearer ${owner.token}`).responseType('blob').expect(200)
    expect(download.headers['content-type']).toBe('application/pdf')
    expect(download.headers['content-disposition']).toBe('attachment; filename="restiq-agreement-v1-signed.pdf"')
    expect(Buffer.compare(download.body as Buffer, pdf)).toBe(0)
    await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements/${v1.id}/pdf`).set('Authorization', `Bearer ${opsToken}`).responseType('blob').expect(200)

    expect(((await startSigning(owner.token, v1.id).expect(409)).body as ErrorBody).error.code).toBe('already_signed')

    // A new version re-opens signing; the old one can no longer be signed.
    const v2 = ((await publish('Terms v2', 'Body two').expect(201)).body as VersionBody).version
    const reopened = await ownerView(owner.token)
    expect(reopened.current?.id).toBe(v2.id)
    expect(reopened).toMatchObject({ signature: null, signing: null })
    expect(reopened.history.map((h) => h.version)).toEqual([1])
    expect(((await startSigning(owner.token, v1.id).expect(409)).body as ErrorBody).error.code).toBe('stale_version')
    await startSigning(owner.token, uuidv7()).expect(404)

    const opsView = await request(httpServer).get(`/ops/v1/tenants/${owner.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(opsView.body).toMatchObject({ status: 'pending', current: { id: v2.id, version: 2 } })
    expect((opsView.body as { signatures: SignatureBody[] }).signatures).toEqual([expect.objectContaining({ version: 1, signerName: 'Asha Rao', hasPdf: true })])
    const listed = (await request(httpServer).get('/ops/v1/agreements').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as {
      versions: Array<{ version: number; signatureCount: number }>
    }
    expect(listed.versions.find((v) => v.version === 1)?.signatureCount).toBe(1)
  })

  it('fails closed when DocuSign is not configured, and a declined envelope lets the owner start again', async () => {
    const owner = await createOwner(prisma, 'Config Tenant')
    const v1 = ((await publish('Terms v1', 'Body one').expect(201)).body as VersionBody).version

    docusign.configured = false
    expect(((await startSigning(owner.token, v1.id).expect(503)).body as ErrorBody).error.code).toBe('esign_unavailable')
    expect(await prisma.agreementEnvelope.count({ where: { tenantId: owner.tenantId } })).toBe(0)
    await ownerView(owner.token)

    docusign.configured = true
    await startSigning(owner.token, v1.id).expect(201)
    docusign.update('env-1', { status: 'declined' })
    expect((await ownerView(owner.token)).signing).toBeNull()
    await startSigning(owner.token, v1.id).expect(201)
    expect(docusign.envelopes.size).toBe(2)
  })

  it("a tenant never sees another tenant's signature or PDF; no version at all is reported as such", async () => {
    const a = await createOwner(prisma, 'Tenant A')
    const b = await createOwner(prisma, 'Tenant B')

    expect(await ownerView(a.token)).toEqual({ current: null, signature: null, signing: null, history: [] })
    const opsNone = await request(httpServer).get(`/ops/v1/tenants/${a.tenantId}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(200)
    expect(opsNone.body).toMatchObject({ status: 'no_agreement', current: null })
    await startSigning(a.token, uuidv7()).expect(404)

    const v1 = ((await publish('Terms v1', 'Body one').expect(201)).body as VersionBody).version
    await startSigning(a.token, v1.id, { signerName: 'Owner A', signerTitle: 'Owner' }).expect(201)
    docusign.update('env-1', { status: 'completed', ownerSignedAt: new Date(), completedAt: new Date() })
    expect((await ownerView(a.token)).signature?.signerName).toBe('Owner A')

    const seenByB = await ownerView(b.token)
    expect(seenByB).toMatchObject({ signature: null, signing: null, history: [] })
    await request(httpServer).get(`/admin/v1/agreement/${v1.id}/pdf`).set('Authorization', `Bearer ${b.token}`).expect(404)
    await startSigning(b.token, v1.id, { signerName: 'Owner B', signerTitle: 'Owner' }).expect(201)
    expect(docusign.envelopes.get('env-2')?.signer.clientUserId).toBe(b.ownerId)

    await request(httpServer).get('/ops/v1/agreements').expect(401)
    await request(httpServer).get('/admin/v1/agreement').expect(401)
    await request(httpServer).get(`/admin/v1/agreement/${v1.id}/pdf`).expect(401)
    await request(httpServer).get(`/ops/v1/tenants/${uuidv7()}/agreements`).set('Authorization', `Bearer ${opsToken}`).expect(404)
  })
})
