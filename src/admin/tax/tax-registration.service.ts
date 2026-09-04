import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { TaxRegistrationView, UpdateTaxRegistrationDto } from './tax-registration.dtos'

const TAX_REGISTRATION_TYPE = {
  IN: 'gstin',
  AU: 'abn',
} as const

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

function toView(country: string, registrationType: 'gstin' | 'abn', registration: {
  registrationNumber: string
  legalEntityName: string
  taxProfile: string
  fssaiLicense: string | null
  compositionScheme: boolean
  gstRegistered: boolean
} | null, tenantName: string): TaxRegistrationView {
  return {
    country,
    registrationType,
    registrationNumber: registration?.registrationNumber ?? null,
    legalEntityName: registration?.legalEntityName ?? tenantName,
    taxProfile: registration?.taxProfile ?? '',
    fssaiLicense: registration?.fssaiLicense ?? null,
    compositionScheme: registration?.compositionScheme ?? false,
    gstRegistered: registration?.gstRegistered ?? true,
  }
}

@Injectable()
export class TaxRegistrationService {
  constructor(private readonly registry: RegionRegistryService) {}

  async get(owner: AdminPrincipal): Promise<TaxRegistrationView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)

      const [tenant, registration] = await Promise.all([
        tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { country: true, name: true } }),
        tx.tenantTaxRegistration.findFirst({ where: { tenantId: owner.tenantId } }),
      ])
      if (!tenant) {
        throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      }

      const registrationType = tenant.country === 'IN' ? TAX_REGISTRATION_TYPE.IN : TAX_REGISTRATION_TYPE.AU
      return toView(tenant.country, registrationType, registration, tenant.name)
    })
  }

  async update(owner: AdminPrincipal, dto: UpdateTaxRegistrationDto): Promise<TaxRegistrationView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())

    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)

      const [tenant, existing] = await Promise.all([
        tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { country: true, name: true } }),
        tx.tenantTaxRegistration.findFirst({ where: { tenantId: owner.tenantId } }),
      ])
      if (!tenant) {
        throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      }

      if (tenant.country === 'IN' && dto.gstRegistered === false) {
        throw new BadRequestException({ code: 'validation_failed', message: 'IN tenants cannot set gstRegistered to false' })
      }

      const registrationType = tenant.country === 'IN' ? TAX_REGISTRATION_TYPE.IN : TAX_REGISTRATION_TYPE.AU
      const updateData = {
        registrationType,
        registrationNumber: dto.registrationNumber ?? existing?.registrationNumber ?? '',
        legalEntityName: dto.legalEntityName ?? existing?.legalEntityName ?? tenant.name,
        taxProfile: dto.taxProfile ?? existing?.taxProfile ?? '',
        fssaiLicense: dto.fssaiLicense ?? existing?.fssaiLicense ?? null,
        compositionScheme: dto.compositionScheme ?? existing?.compositionScheme ?? false,
        gstRegistered: dto.gstRegistered ?? existing?.gstRegistered ?? true,
      }

      try {
        if (existing) {
          const updated = await tx.tenantTaxRegistration.update({
            where: { id: existing.id },
            data: {
              legalEntityName: dto.legalEntityName ?? existing.legalEntityName,
              taxProfile: dto.taxProfile ?? existing.taxProfile,
              fssaiLicense: dto.fssaiLicense ?? existing.fssaiLicense,
              compositionScheme: dto.compositionScheme ?? existing.compositionScheme,
              registrationNumber: dto.registrationNumber ?? existing.registrationNumber,
              gstRegistered: dto.gstRegistered ?? existing.gstRegistered,
            },
          })
          return toView(tenant.country, registrationType, updated, tenant.name)
        }

        const created = await tx.tenantTaxRegistration.create({
          data: { tenantId: owner.tenantId, ...updateData },
        })
        return toView(tenant.country, registrationType, created, tenant.name)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({
            code: 'conflict',
            message: 'A tenant with this registration number already exists',
          })
        }
        throw error
      }
    })
  }
}
