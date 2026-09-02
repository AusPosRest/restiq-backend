import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { OpsPrincipal, PrismaService, RegionRegistryService, uuidv7 } from '../../platform'
import { SubmitTenantDto } from './submit.dto'

export const WIZARD_STEP_COUNT = 5
const DRAFT_STEP_MAX_BYTES = 16_384
export const OWNER_INVITE_TTL_HOURS = 7 * 24
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
  tenant: { id: string; name: string; status: string }
  // inviteToken is the raw accept token, exposed exactly once here: there is
  // no mailer in this prototype, so the ops console must be able to show a
  // copyable accept link (issue #85). Only the hash is stored.
  invite: { email: string; expiresAt: string; inviteToken: string }
}

@Injectable()
export class OpsTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
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
        throw new ConflictException({
          code: 'conflict',
          message: 'A tenant with this tax registration number already exists',
        })
      }
      throw error
    }

    return {
      tenant: { id: tenantId, name: dto.business.companyName, status: 'provisioning' },
      invite: { email: invite.email, expiresAt: invite.expiresAt.toISOString(), inviteToken },
    }
  }

  private validateTaxNumber(dto: SubmitTenantDto): void {
    const { country, registrationNumber } = dto.tax
    const ok = country === 'IN' ? GSTIN_PATTERN.test(registrationNumber) : ABN_PATTERN.test(registrationNumber)
    if (!ok) {
      const label = country === 'IN' ? 'GSTIN (15 characters, e.g. 29ABCDE1234F1Z5)' : 'ABN (11 digits)'
      throw new BadRequestException({ code: 'validation_failed', message: `registrationNumber is not a valid ${label}` })
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}
