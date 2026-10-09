// CAP-10 outlet listing + per-outlet capability toggles. Listing reads data
// story 2's onboarding wizard already writes to `outlets` - no new columns.
// Capability toggling is a routine content edit (SPEC constraint) - no audit
// reason required, unlike price changes or PIN revocation.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { CapabilityView, OutletView, UpdateOutletDto } from './outlets.dtos'
import { applyStarterSetup, StarterSetupResult } from './starter-setup'

@Injectable()
export class OutletsService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal): Promise<OutletView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const outlets = await tx.outlet.findMany({
        where: { tenantId: owner.tenantId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      })
      return outlets.map((o) => ({ id: o.id, name: o.name, address: o.address, type: o.type, timezone: o.timezone }))
    })
  }

  async listCapabilities(owner: AdminPrincipal, outletId: string): Promise<CapabilityView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
      const rows = await tx.outletCapability.findMany({ where: { outletId } })
      return rows.map((r) => ({ key: r.key, enabled: r.enabled }))
    })
  }

  async setCapability(owner: AdminPrincipal, outletId: string, key: string, enabled: boolean): Promise<CapabilityView> {
    if (key.trim().length === 0) {
      throw new BadRequestException({ code: 'validation_failed', message: 'key must not be empty' })
    }
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
      const row = await tx.outletCapability.upsert({
        where: { outletId_key: { outletId, key } },
        create: { tenantId: owner.tenantId, outletId, key, enabled },
        update: { enabled },
      })
      return { key: row.key, enabled: row.enabled }
    })
  }

  // Routine content edit (SPEC constraint, same as capability toggling) - no audit reason required.
  async update(owner: AdminPrincipal, outletId: string, dto: UpdateOutletDto): Promise<OutletView> {
    if (dto.name === undefined && dto.address === undefined && dto.timezone === undefined) {
      throw new BadRequestException({ code: 'validation_failed', message: 'nothing to change' })
    }
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== owner.tenantId || outlet.deletedAt) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
      const updated = await tx.outlet.update({
        where: { id: outletId },
        data: { name: dto.name, address: dto.address, timezone: dto.timezone },
      })
      return { id: updated.id, name: updated.name, address: updated.address, type: updated.type, timezone: updated.timezone }
    })
  }

  /** Builds the outlet type's starting stations, tables and switches; safe to run again - it only adds what is missing. */
  async applyStarterSetup(owner: AdminPrincipal, outletId: string): Promise<StarterSetupResult> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== owner.tenantId || outlet.deletedAt) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
      return applyStarterSetup(tx, owner.tenantId, outletId, outlet.type)
    })
  }
}
