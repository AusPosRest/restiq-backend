import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { MailMessage, MailService, OpsPrincipal, PrismaService, RegionRegistryService, slugify, slugProblem, uuidv7, webLink } from '../../platform'
import { applyStarterSetup } from '../../admin/outlets/starter-setup'
import { SubmitTenantDto } from './submit.dto'

export const WIZARD_STEP_COUNT = 5
const DRAFT_STEP_MAX_BYTES = 16_384
export const OWNER_INVITE_TTL_HOURS = 7 * 24

/** #198: the owner invite email, sent on onboarding and on every regenerated invite. */
export function ownerInviteEmail(to: string, firstName: string, restaurant: string, token: string): MailMessage {
  const link = webLink(`/admin/invite/${token}`)
  const days = OWNER_INVITE_TTL_HOURS / 24
  return {
    to,
    subject: `Set up ${restaurant} on RESTIQ`,
    text: `Hi ${firstName},\n\n${restaurant} is ready on RESTIQ. Open this link within ${days} days to choose your password and sign in to the owner console:\n${link}\n\nIf you weren't expecting this, ignore this email.`,
    html: `<p>Hi ${escapeHtml(firstName)},</p><p>${escapeHtml(restaurant)} is ready on RESTIQ.</p><p><a href="${link}">Set up your owner account</a> (the link works for ${days} days).</p><p>If you weren't expecting this, ignore this email.</p>`,
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
const DEFAULT_PROVISION_REASON = 'Provisioned via console onboarding wizard'

// Seeded so the owner lands in a working system (FR-2): the six cloneable
// system roles (FR-13) and a minimal sample menu. isManager marks which of
// these can approve a CAP-8 gated action (platform/manager-auth, AD-15) -
// 'Owner' and 'Manager' only, since they're the only roles a real
// restaurant would trust with void/discount/refund authority.
const SYSTEM_ROLES: ReadonlyArray<{ name: string; isManager: boolean }> = [
  { name: 'Owner', isManager: true },
  { name: 'Manager', isManager: true },
  { name: 'Cashier', isManager: false },
  { name: 'Waiter', isManager: false },
  { name: 'Kitchen', isManager: false },
  { name: 'Accountant', isManager: false },
]
const SAMPLE_MENU: ReadonlyArray<{
  category: string
  items: ReadonlyArray<{ name: string; shortName: string; priceMinor: bigint }>
}> = [
  {
    category: 'Starters',
    items: [
      { name: 'Garden Salad', shortName: 'Garden Salad', priceMinor: 19900n },
      { name: 'Soup of the Day', shortName: 'Soup', priceMinor: 14900n },
    ],
  },
  {
    category: 'Mains',
    items: [
      { name: 'House Curry', shortName: 'House Curry', priceMinor: 32900n },
      { name: 'Grilled Sandwich', shortName: 'Grilled Sndwch', priceMinor: 24900n },
    ],
  },
  {
    category: 'Beverages',
    items: [
      { name: 'Fresh Lime Soda', shortName: 'Lime Soda', priceMinor: 9900n },
      { name: 'Filter Coffee', shortName: 'Filter Coffee', priceMinor: 7900n },
    ],
  },
]

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const ABN_PATTERN = /^\d{11}$/

export interface DraftView {
  steps: Record<string, unknown>
  updatedAt: string
}

export interface ProvisionResult {
  tenant: { id: string; name: string; slug: string; status: string }
  // inviteToken is the raw accept token, exposed exactly once here: there is
  // no mailer in this prototype, so the ops console must be able to show a
  // copyable accept link (issue #85). Only the hash is stored.
  invite: { email: string; expiresAt: string; inviteToken: string }
}

@Injectable()
export class OpsTenantsService {
  private readonly logger = new Logger(OpsTenantsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
    private readonly mail: MailService,
  ) {}

  // --- Drafts (control plane): an operator's in-flight wizard, never a tenant.

  async getDraft(operatorId: string): Promise<DraftView> {
    const draft = await this.prisma.client.onboardingDraft.findUnique({ where: { operatorId } })
    if (!draft) {
      throw new NotFoundException({ code: 'not_found', message: 'No onboarding draft exists for this operator' })
    }
    return { steps: draft.steps as Record<string, unknown>, updatedAt: draft.updatedAt.toISOString() }
  }

  async saveDraftStep(operatorId: string, step: number, data: unknown): Promise<{ updatedAt: string }> {
    if (!Number.isInteger(step) || step < 1 || step > WIZARD_STEP_COUNT) {
      throw new BadRequestException({ code: 'validation_failed', message: `step must be between 1 and ${WIZARD_STEP_COUNT}` })
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new BadRequestException({ code: 'validation_failed', message: 'Step data must be a JSON object' })
    }
    if (Buffer.byteLength(JSON.stringify(data)) > DRAFT_STEP_MAX_BYTES) {
      throw new BadRequestException({ code: 'validation_failed', message: 'Step data is too large' })
    }

    const stepData = data as Prisma.InputJsonObject
    const existing = await this.prisma.client.onboardingDraft.findUnique({ where: { operatorId } })
    const steps = { ...((existing?.steps ?? {}) as Prisma.JsonObject), [String(step)]: stepData }
    const draft = await this.prisma.client.onboardingDraft.upsert({
      where: { operatorId },
      create: { operatorId, steps },
      update: { steps },
    })
    return { updatedAt: draft.updatedAt.toISOString() }
  }

  async deleteDraft(operatorId: string): Promise<void> {
    await this.prisma.client.onboardingDraft.deleteMany({ where: { operatorId } })
  }

  // --- Final submit: ONE transaction creating everything (CAP-2). Any
  // failure rolls the whole thing back; the draft is only deleted on success.

  async provision(operator: OpsPrincipal, dto: SubmitTenantDto): Promise<ProvisionResult> {
    this.validateTaxNumber(dto)
    this.validateGstRate(dto)
    const slug = await this.chooseSlug(dto)

    const region = this.registry.homeRegion()
    const plane = this.registry.planeFor(region)
    const tenantId = uuidv7()
    const now = new Date()
    const inviteToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(now.getTime() + OWNER_INVITE_TTL_HOURS * 3_600_000)
    const currency = dto.tax.country === 'IN' ? 'INR' : 'AUD'
    const reason = dto.reason ?? DEFAULT_PROVISION_REASON

    let invite: { email: string; expiresAt: Date }
    try {
      invite = await plane.$transaction(async (tx) => {
        // RLS (AD-5): every row below must carry this tenant id.
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`

        // Control-plane registry entry (AD-9): existence + region, no state.
        await tx.tenantRegistryEntry.create({ data: { tenantId, region, lifecycle: 'active' } })

        await tx.tenant.create({
          data: {
            id: tenantId,
            name: dto.business.companyName,
            slug,
            registeredAddress: dto.business.registeredAddress,
            contactName: dto.business.contactName,
            contactEmail: dto.business.contactEmail,
            contactPhone: dto.business.contactPhone,
            country: dto.tax.country,
            status: 'provisioning',
            plan: dto.subscription.plan,
            billingPeriod: dto.subscription.billingPeriod,
          },
        })

        await tx.tenantTaxRegistration.create({
          data: {
            tenantId,
            registrationType: dto.tax.country === 'IN' ? 'gstin' : 'abn',
            registrationNumber: dto.tax.registrationNumber,
            legalEntityName: dto.tax.legalEntityName,
            taxProfile: dto.tax.taxProfile,
            fssaiLicense: dto.tax.fssaiLicense ?? null,
            compositionScheme: dto.tax.compositionScheme ?? false,
            gstRegistered: dto.tax.gstRegistered ?? true,
            gstRatePercent: dto.tax.gstRatePercent ?? null,
          },
        })

        const brand = await tx.brand.create({ data: { tenantId, name: dto.brandsOutlets.brandName } })
        await tx.outlet.createMany({
          data: dto.brandsOutlets.outlets.map((outlet) => ({
            tenantId,
            brandId: brand.id,
            name: outlet.name,
            address: outlet.address,
            type: outlet.type,
            timezone: outlet.timezone,
          })),
        })
        // D2: every new outlet starts with its type's stations, tables and switches; the owner edits from there.
        for (const outlet of await tx.outlet.findMany({ where: { tenantId }, select: { id: true, type: true } })) {
          await applyStarterSetup(tx, tenantId, outlet.id, outlet.type)
        }

        await tx.role.createMany({
          data: SYSTEM_ROLES.map(({ name, isManager }) => ({ tenantId, name, isSystem: true, isManager })),
        })

        for (const [index, { category, items }] of SAMPLE_MENU.entries()) {
          const createdCategory = await tx.menuCategory.create({ data: { tenantId, name: category, sortOrder: index + 1 } })
          for (const item of items) {
            const createdItem = await tx.menuItem.create({
              data: { tenantId, categoryId: createdCategory.id, name: item.name, shortName: item.shortName },
            })
            // AD-11: price is insert-only from the first row onward, even for seed data.
            await tx.itemPrice.create({
              data: { tenantId, itemId: createdItem.id, priceMinor: item.priceMinor, currency },
            })
          }
        }

        const createdInvite = await tx.ownerInvite.create({
          data: {
            tenantId,
            email: dto.ownerInvite.email,
            firstName: dto.ownerInvite.firstName,
            lastName: dto.ownerInvite.lastName,
            tokenHash: createHash('sha256').update(inviteToken).digest('hex'),
            expiresAt,
          },
        })

        // Audit in the SAME transaction (AD-6), region-side (AD-8).
        await tx.auditEvent.create({
          data: {
            tenantId,
            actorId: operator.id,
            actorEmail: operator.email,
            action: 'tenant.provisioned',
            reason,
            occurredAt: now,
          },
        })

        // Same database in v1, so the draft cleanup joins the transaction:
        // success removes it, failure keeps it (resumable, CAP-2).
        await tx.onboardingDraft.deleteMany({ where: { operatorId: operator.id } })

        return { email: createdInvite.email, expiresAt: createdInvite.expiresAt }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Both the tax number and the subdomain are unique; a slug lost in a race is the only way the second fires here.
        const target = JSON.stringify((error as { meta?: unknown }).meta ?? '')
        if (target.includes('slug')) throw new ConflictException({ code: 'slug_taken', message: 'That subdomain was just taken - choose another' })
        throw new ConflictException({
          code: 'conflict',
          message: 'A tenant with this tax registration number already exists',
        })
      }
      throw error
    }

    // Sent after the commit, in the background: a mail outage must not undo the onboarding.
    void this.mail
      .send(ownerInviteEmail(invite.email, dto.ownerInvite.firstName, dto.business.companyName, inviteToken))
      .catch((error: unknown) => this.logger.error(`Owner invite email failed: ${String(error)}`))

    return {
      tenant: { id: tenantId, name: dto.business.companyName, slug, status: 'provisioning' },
      invite: { email: invite.email, expiresAt: invite.expiresAt.toISOString(), inviteToken },
    }
  }

  /** The subdomain the ops person asked for, checked; or one made from the company name, numbered on a clash. */
  private async chooseSlug(dto: SubmitTenantDto): Promise<string> {
    if (dto.slug !== undefined && dto.slug !== '') {
      const slug = dto.slug.trim().toLowerCase()
      const problem = slugProblem(slug)
      if (problem === 'invalid') throw new BadRequestException({ code: 'slug_invalid', message: 'A subdomain is 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit' })
      if (problem === 'reserved') throw new BadRequestException({ code: 'slug_reserved', message: 'That subdomain is reserved - choose another' })
      if (await this.slugTaken(slug)) throw new ConflictException({ code: 'slug_taken', message: 'That subdomain is already used by another restaurant' })
      return slug
    }
    const base = slugify(dto.business.companyName)
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? base : `${base.slice(0, 29)}-${n}`
      if (slugProblem(candidate) === null && !(await this.slugTaken(candidate))) return candidate
    }
    throw new ConflictException({ code: 'slug_taken', message: 'No subdomain could be made from that company name - choose one' })
  }

  async slugTaken(slug: string): Promise<boolean> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    const found = await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      return tx.tenant.findUnique({ where: { slug }, select: { id: true } })
    })
    return found !== null
  }

  private validateTaxNumber(dto: SubmitTenantDto): void {
    const { country, registrationNumber } = dto.tax
    const ok = country === 'IN' ? GSTIN_PATTERN.test(registrationNumber) : ABN_PATTERN.test(registrationNumber)
    if (!ok) {
      const label = country === 'IN' ? 'GSTIN (15 characters, e.g. 29ABCDE1234F1Z5)' : 'ABN (11 digits)'
      throw new BadRequestException({ code: 'validation_failed', message: `registrationNumber is not a valid ${label}` })
    }
  }

  private validateGstRate(dto: SubmitTenantDto): void {
    if (dto.tax.gstRatePercent !== undefined && dto.tax.gstRegistered === false) {
      throw new BadRequestException({ code: 'validation_failed', message: 'gstRatePercent is only allowed when gstRegistered is not false' })
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}
