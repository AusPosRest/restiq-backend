// Platform agreements (issues #132, #150): operators publish immutable
// numbered versions; a tenant owner signs the current one through DocuSign
// (embedded in the console), the platform's authorised signatory
// countersigns by email, and the completed, sealed PDF is stored with the
// signature. One service, two realms (same AD-12 shape as DevicesService) -
// the ops controller publishes/reads, the admin controller reads/signs.
import { createHash } from 'node:crypto'
import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, ControlPlaneAuditService, OpsPrincipal, RegionRegistryService } from '../../platform'
import { CustomerFields, mergeCustomerFields, renderAgreementHtml } from './agreement-document'
import {
  AgreementSignatureView,
  AgreementVersionSummary,
  AgreementVersionView,
  OwnerAgreementView,
  OwnerSigningView,
  PublishAgreementDto,
  StartSigningDto,
  TenantAgreementsView,
} from './agreements.dtos'
import { DocuSignClient, EnvelopeState } from './docusign.client'

type VersionRow = { id: string; version: number; title: string; body: string; bodySha256: string; publishedBy: string; publishedAt: Date }
type SignatureRow = {
  agreementVersionId: string
  signerName: string
  signerEmail: string
  signerTitle: string | null
  signedAt: Date
  evidenceSha256: string
  envelopeId: string | null
  version: { version: number; title: string }
}
type EnvelopeRow = {
  id: string
  tenantId: string
  agreementVersionId: string
  envelopeId: string
  signerOwnerId: string
  signerName: string
  signerEmail: string
  signerTitle: string
  ownerSignedAt: Date | null
  version: { version: number; title: string }
}

const VERSION_SELECT = { id: true, version: true, title: true, body: true, bodySha256: true, publishedBy: true, publishedAt: true } as const
const SIGNATURE_SELECT = {
  agreementVersionId: true,
  signerName: true,
  signerEmail: true,
  signerTitle: true,
  signedAt: true,
  evidenceSha256: true,
  envelopeId: true,
  version: { select: { version: true, title: true } },
} as const
const ENVELOPE_SELECT = {
  id: true,
  tenantId: true,
  agreementVersionId: true,
  envelopeId: true,
  signerOwnerId: true,
  signerName: true,
  signerEmail: true,
  signerTitle: true,
  ownerSignedAt: true,
  version: { select: { version: true, title: true } },
} as const

const NO_VERSION = { code: 'not_found', message: 'No such agreement version' }

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
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
    signerTitle: row.signerTitle,
    signedAt: row.signedAt.toISOString(),
    evidenceSha256: row.evidenceSha256,
    // Every DocuSign signature is written together with its sealed PDF.
    hasPdf: row.envelopeId !== null,
  }
}

function toSigningView(row: EnvelopeRow): OwnerSigningView {
  return {
    status: row.ownerSignedAt ? 'awaiting_countersign' : 'awaiting_owner',
    signerName: row.signerName,
    signerTitle: row.signerTitle,
    ownerSignedAt: row.ownerSignedAt?.toISOString() ?? null,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

@Injectable()
export class AgreementsService {
  private readonly logger = new Logger(AgreementsService.name)

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly audit: ControlPlaneAuditService,
    private readonly docusign: DocuSignClient,
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
    if (!row) throw new NotFoundException(NO_VERSION)
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
    await this.syncOpenEnvelopes(tenantId)
    return this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId, deletedAt: null }, select: { id: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      const [current, signatures] = await Promise.all([this.current(tx), this.signatures(tx, tenantId)])
      const signed = current !== null && signatures.some((s) => s.agreementVersionId === current.id)
      const open = current && !signed ? await this.openEnvelope(tx, tenantId, current.id) : null
      return {
        current: current && { id: current.id, version: current.version, title: current.title, publishedBy: current.publishedBy, publishedAt: current.publishedAt.toISOString() },
        status: current === null ? 'no_agreement' : signed ? 'signed' : open?.ownerSignedAt ? 'awaiting_countersign' : 'pending',
        signatures: signatures.map(toSignatureView),
      }
    })
  }

  async ownerView(owner: AdminPrincipal): Promise<OwnerAgreementView> {
    await this.syncOpenEnvelopes(owner.tenantId)
    return this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
      const [current, signatures] = await Promise.all([this.current(tx), this.signatures(tx, owner.tenantId)])
      const history = signatures.map(toSignatureView)
      const signature = current ? (history.find((s) => s.agreementVersionId === current.id) ?? null) : null
      const open = current && !signature ? await this.openEnvelope(tx, owner.tenantId, current.id) : null
      return {
        current: current && {
          id: current.id,
          version: current.version,
          title: current.title,
          body: mergeCustomerFields(current.body, await this.customerFields(tx, owner.tenantId)),
          publishedAt: current.publishedAt.toISOString(),
        },
        signature,
        signing: open && toSigningView(open),
        history,
      }
    })
  }

  /**
   * Opens (or resumes) the owner's DocuSign signing session on the current
   * version and returns the one-time URL to send them to. The envelope is
   * created on first use: the document carries the tenant's details and the
   * signer's name and title, the owner signs first (embedded), the platform
   * countersigns second (by email).
   */
  async startSigning(owner: AdminPrincipal, versionId: string, dto: StartSigningDto): Promise<{ url: string }> {
    // Both checked before any work, so an unconfigured platform fails closed with a clear 503.
    const { countersigner } = this.docusign.config()
    const webOrigin = process.env.WEB_ORIGIN
    if (!webOrigin) throw new ServiceUnavailableException({ code: 'esign_unavailable', message: 'Electronic signing is not set up yet. Contact Restiq support.' })

    await this.syncOpenEnvelopes(owner.tenantId)
    const prepared = await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
      const current = await this.current(tx)
      if (!current) throw new NotFoundException(NO_VERSION)
      if (current.id !== versionId) {
        const exists = await tx.agreementVersion.count({ where: { id: versionId } })
        if (exists === 0) throw new NotFoundException(NO_VERSION)
        throw new ConflictException({ code: 'stale_version', message: `Only the current agreement (v${current.version}) can be signed` })
      }
      const signed = await tx.agreementSignature.count({ where: { tenantId: owner.tenantId, agreementVersionId: current.id } })
      if (signed > 0) throw new ConflictException({ code: 'already_signed', message: 'This agreement version is already signed for your business' })
      const open = await this.openEnvelope(tx, owner.tenantId, current.id)
      return { current, open, customer: open ? null : await this.customerFields(tx, owner.tenantId) }
    })

    let envelope = prepared.open
    if (envelope && envelope.signerOwnerId !== owner.id) {
      throw new ConflictException({ code: 'signing_in_progress', message: `${envelope.signerName} (${envelope.signerEmail}) has already started signing this version` })
    }
    if (envelope?.ownerSignedAt) {
      throw new ConflictException({ code: 'awaiting_countersign', message: 'You have signed. Restiq has been asked to countersign.' })
    }
    if (!envelope) {
      const { current, customer } = prepared
      const signerName = dto.signerName.trim()
      const signerTitle = dto.signerTitle.trim()
      const html = renderAgreementHtml({
        title: current.title,
        version: current.version,
        body: current.body,
        customer: customer ?? (await this.plane.$transaction((tx) => this.customerFields(tx, owner.tenantId))),
        signer: { name: signerName, title: signerTitle },
        countersigner,
      })
      const envelopeId = await this.docusign.createEnvelope({
        emailSubject: `Please sign: ${current.title} (v${current.version})`,
        documentName: `${current.title} v${current.version}.html`,
        html,
        signer: { name: signerName, email: owner.email, clientUserId: owner.id },
      })
      try {
        envelope = await this.plane.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
          const created = await tx.agreementEnvelope.create({
            data: { tenantId: owner.tenantId, agreementVersionId: current.id, envelopeId, signerOwnerId: owner.id, signerName, signerEmail: owner.email, signerTitle },
            select: ENVELOPE_SELECT,
          })
          await tx.auditEvent.create({
            data: {
              tenantId: owner.tenantId,
              actorId: owner.id,
              actorEmail: owner.email,
              action: 'agreement.signing_started',
              reason: `Started signing agreement v${current.version} "${current.title}" as ${signerName} (${signerTitle}), DocuSign envelope ${envelopeId}`,
              occurredAt: new Date(),
            },
          })
          return created
        })
      } catch (error) {
        // ponytail: the losing tab's envelope stays unsigned in DocuSign; void it through the API if that clutter ever matters.
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'signing_in_progress', message: 'Signing was started in another window. Reload the page to continue.' })
        throw error
      }
    }

    const url = await this.docusign.signingUrl(
      envelope.envelopeId,
      { name: envelope.signerName, email: envelope.signerEmail, clientUserId: owner.id },
      `${webOrigin.replace(/\/+$/, '')}/admin/settings/agreement`,
    )
    return { url }
  }

  async signedPdf(tenantId: string, versionId: string): Promise<{ pdf: Uint8Array; filename: string }> {
    const row = await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.agreementSignature.findFirst({ where: { tenantId, agreementVersionId: versionId }, select: { signedPdf: true, version: { select: { version: true } } } })
    })
    if (!row?.signedPdf) throw new NotFoundException({ code: 'not_found', message: 'No signed PDF for this agreement version' })
    return { pdf: row.signedPdf, filename: `restiq-agreement-v${row.version.version}-signed.pdf` }
  }

  // ponytail: completion is picked up when the owner or ops next opens the
  // agreement (one DocuSign GET per open envelope). Add a DocuSign Connect
  // webhook if it must land without anyone looking.
  private async syncOpenEnvelopes(tenantId: string): Promise<void> {
    const open = await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.agreementEnvelope.findMany({ where: { tenantId, status: 'sent' }, select: ENVELOPE_SELECT })
    })
    for (const envelope of open) {
      try {
        const state = await this.docusign.envelopeState(envelope.envelopeId)
        if (state.status === 'completed') {
          await this.complete(envelope, state, await this.docusign.completedPdf(envelope.envelopeId))
        } else if (state.status === 'declined' || state.status === 'voided') {
          await this.updateOpenEnvelope(envelope, { status: state.status })
        } else if (state.ownerSignedAt && !envelope.ownerSignedAt) {
          await this.updateOpenEnvelope(envelope, { ownerSignedAt: state.ownerSignedAt })
        }
      } catch (error) {
        // A DocuSign outage must not take the agreement page down: the envelope stays open and is retried on the next read.
        this.logger.warn(`DocuSign envelope ${envelope.envelopeId} could not be synced: ${String(error)}`)
      }
    }
  }

  private async complete(envelope: EnvelopeRow, state: EnvelopeState, pdf: Buffer): Promise<void> {
    const signedAt = state.ownerSignedAt ?? envelope.ownerSignedAt ?? state.completedAt ?? new Date()
    await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${envelope.tenantId}, true)`
      // Claims the envelope so two concurrent reads can't both write the signature.
      const claimed = await tx.agreementEnvelope.updateMany({ where: { id: envelope.id, status: 'sent' }, data: { status: 'completed', ownerSignedAt: signedAt } })
      if (claimed.count === 0) return
      await tx.agreementSignature.create({
        data: {
          tenantId: envelope.tenantId,
          agreementVersionId: envelope.agreementVersionId,
          signerOwnerId: envelope.signerOwnerId,
          signerName: envelope.signerName,
          signerEmail: envelope.signerEmail,
          signerTitle: envelope.signerTitle,
          envelopeId: envelope.envelopeId,
          signedPdf: new Uint8Array(pdf),
          evidenceSha256: sha256(pdf),
          signedAt,
        },
      })
      await tx.auditEvent.create({
        data: {
          tenantId: envelope.tenantId,
          actorId: envelope.signerOwnerId,
          actorEmail: envelope.signerEmail,
          action: 'agreement.signed',
          reason: `Signed agreement v${envelope.version.version} "${envelope.version.title}" as ${envelope.signerName} (${envelope.signerTitle}); countersigned and sealed by DocuSign, envelope ${envelope.envelopeId}`,
          occurredAt: signedAt,
        },
      })
    })
  }

  private async updateOpenEnvelope(envelope: EnvelopeRow, data: { status?: string; ownerSignedAt?: Date }): Promise<void> {
    await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${envelope.tenantId}, true)`
      await tx.agreementEnvelope.updateMany({ where: { id: envelope.id, status: 'sent' }, data })
    })
  }

  /** The tenant's details for the parties clause: the registered legal entity when there is one, else the business name. */
  private async customerFields(tx: Prisma.TransactionClient, tenantId: string): Promise<CustomerFields> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        registeredAddress: true,
        country: true,
        taxRegistrations: { select: { legalEntityName: true, registrationType: true, registrationNumber: true }, take: 1 },
      },
    })
    if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    const registration = tenant.taxRegistrations.at(0)
    return {
      legalName: registration?.legalEntityName ?? tenant.name,
      address: tenant.registeredAddress,
      country: tenant.country,
      taxId: registration ? `${registration.registrationType === 'abn' ? 'ABN' : 'GSTIN'} ${registration.registrationNumber}` : null,
    }
  }

  private current(tx: Prisma.TransactionClient): Promise<VersionRow | null> {
    return tx.agreementVersion.findFirst({ orderBy: { version: 'desc' }, select: VERSION_SELECT })
  }

  private signatures(tx: Prisma.TransactionClient, tenantId: string): Promise<SignatureRow[]> {
    return tx.agreementSignature.findMany({ where: { tenantId }, orderBy: { signedAt: 'desc' }, select: SIGNATURE_SELECT })
  }

  private openEnvelope(tx: Prisma.TransactionClient, tenantId: string, versionId: string): Promise<EnvelopeRow | null> {
    return tx.agreementEnvelope.findFirst({ where: { tenantId, agreementVersionId: versionId, status: 'sent' }, select: ENVELOPE_SELECT })
  }
}
