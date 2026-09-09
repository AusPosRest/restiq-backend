// Platform agreements (issue #132): operators publish immutable numbered
// versions; a tenant owner signs the current one. One service, two realms
// (same AD-12 shape as DevicesService) - the ops controller publishes/reads,
// the admin controller reads/signs.
import { createHash } from 'node:crypto'
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, ControlPlaneAuditService, OpsPrincipal, RegionRegistryService } from '../../platform'
import {
  AgreementSignatureView,
  AgreementVersionSummary,
  AgreementVersionView,
  OwnerAgreementView,
  PublishAgreementDto,
  SignAgreementDto,
  TenantAgreementsView,
} from './agreements.dtos'

type VersionRow = { id: string; version: number; title: string; body: string; bodySha256: string; publishedBy: string; publishedAt: Date }
type SignatureRow = {
  agreementVersionId: string
  signerName: string
  signerEmail: string
  signedAt: Date
  evidenceSha256: string
  version: { version: number; title: string }
}

const VERSION_SELECT = { id: true, version: true, title: true, body: true, bodySha256: true, publishedBy: true, publishedAt: true } as const
const SIGNATURE_SELECT = {
  agreementVersionId: true,
  signerName: true,
  signerEmail: true,
  signedAt: true,
  evidenceSha256: true,
  version: { select: { version: true, title: true } },
} as const

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function toSummary(row: VersionRow, signatureCount: number): AgreementVersionSummary {
  return { id: row.id, version: row.version, title: row.title, publishedBy: row.publishedBy, publishedAt: row.publishedAt.toISOString(), signatureCount }
}

function toSignatureView(row: SignatureRow): AgreementSignatureView {
  return {
    agreementVersionId: row.agreementVersionId,
    version: row.version.version,
    title: row.version.title,
    signerName: row.signerName,
    signerEmail: row.signerEmail,
    signedAt: row.signedAt.toISOString(),
    evidenceSha256: row.evidenceSha256,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

@Injectable()
export class AgreementsService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  // ponytail: versions live on the home region plane only; fan out per region if a second region ever ships.
  private get plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async list(): Promise<{ versions: AgreementVersionSummary[] }> {
    const rows = await this.plane.agreementVersion.findMany({
      orderBy: { version: 'desc' },
      select: { ...VERSION_SELECT, _count: { select: { signatures: true } } },
    })
    return { versions: rows.map((row) => toSummary(row, row._count.signatures)) }
  }

  async get(id: string): Promise<{ version: AgreementVersionView }> {
    const row = await this.plane.agreementVersion.findUnique({
      where: { id },
      select: { ...VERSION_SELECT, _count: { select: { signatures: true } } },
    })
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'No such agreement version' })
    return { version: { ...toSummary(row, row._count.signatures), body: row.body, bodySha256: row.bodySha256 } }
  }

  async publish(operator: OpsPrincipal, dto: PublishAgreementDto): Promise<{ version: AgreementVersionView }> {
    const row = await this.plane.$transaction(async (tx) => {
      // Serialises concurrent publishes so version numbers stay gap-free.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agreement_versions'))`
      const latest = await tx.agreementVersion.aggregate({ _max: { version: true } })
      return tx.agreementVersion.create({
        data: {
          version: (latest._max.version ?? 0) + 1,
          title: dto.title,
          body: dto.body,
          bodySha256: sha256(dto.body),
          publishedBy: operator.email,
        },
        select: VERSION_SELECT,
      })
    })
    await this.audit.record({
      actorId: operator.id,
      actorEmail: operator.email,
      action: 'agreement.published',
      reason: `v${row.version} "${row.title}": ${dto.reason}`,
      occurredAt: new Date(),
    })
    return { version: { ...toSummary(row, 0), body: row.body, bodySha256: row.bodySha256 } }
  }

  async forTenant(tenantId: string): Promise<TenantAgreementsView> {
    return this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId, deletedAt: null }, select: { id: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      const [current, signatures] = await Promise.all([this.current(tx), this.signatures(tx, tenantId)])
      const signed = current !== null && signatures.some((s) => s.agreementVersionId === current.id)
      return {
        current: current && { id: current.id, version: current.version, title: current.title, publishedBy: current.publishedBy, publishedAt: current.publishedAt.toISOString() },
        status: current === null ? 'no_agreement' : signed ? 'signed' : 'pending',
        signatures: signatures.map(toSignatureView),
      }
    })
  }

  async ownerView(owner: AdminPrincipal): Promise<OwnerAgreementView> {
    return this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
      const [current, signatures] = await Promise.all([this.current(tx), this.signatures(tx, owner.tenantId)])
      const history = signatures.map(toSignatureView)
      return {
        current: current && { id: current.id, version: current.version, title: current.title, body: current.body, publishedAt: current.publishedAt.toISOString() },
        signature: current ? (history.find((s) => s.agreementVersionId === current.id) ?? null) : null,
        history,
      }
    })
  }

  async sign(owner: AdminPrincipal, versionId: string, dto: SignAgreementDto): Promise<{ signature: AgreementSignatureView }> {
    try {
      const row = await this.plane.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
        const current = await this.current(tx)
        if (!current) throw new NotFoundException({ code: 'not_found', message: 'No such agreement version' })
        if (current.id !== versionId) {
          const exists = await tx.agreementVersion.count({ where: { id: versionId } })
          if (exists === 0) throw new NotFoundException({ code: 'not_found', message: 'No such agreement version' })
          throw new ConflictException({ code: 'stale_version', message: `Only the current agreement (v${current.version}) can be signed` })
        }
        const signedAt = new Date()
        const signerName = dto.signerName.trim()
        const evidenceSha256 = sha256([current.bodySha256, owner.tenantId, owner.id, owner.email, signerName, signedAt.toISOString()].join('\n'))
        const signature = await tx.agreementSignature.create({
          data: { tenantId: owner.tenantId, agreementVersionId: current.id, signerOwnerId: owner.id, signerName, signerEmail: owner.email, evidenceSha256, signedAt },
          select: SIGNATURE_SELECT,
        })
        await tx.auditEvent.create({
          data: {
            tenantId: owner.tenantId,
            actorId: owner.id,
            actorEmail: owner.email,
            action: 'agreement.signed',
            reason: `Signed agreement v${current.version} "${current.title}" as ${signerName}`,
            occurredAt: signedAt,
          },
        })
        return signature
      })
      return { signature: toSignatureView(row) }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'already_signed', message: 'This agreement version is already signed for your business' })
      }
      throw error
    }
  }

  private current(tx: Prisma.TransactionClient): Promise<VersionRow | null> {
    return tx.agreementVersion.findFirst({ orderBy: { version: 'desc' }, select: VERSION_SELECT })
  }

  private signatures(tx: Prisma.TransactionClient, tenantId: string): Promise<SignatureRow[]> {
    return tx.agreementSignature.findMany({ where: { tenantId }, orderBy: { signedAt: 'desc' }, select: SIGNATURE_SELECT })
  }
}
