// CAP-6 devices & printers: a thin tenant-scoped wrapper around the ops
// realm's DevicesService (AD-12 - one enrolment implementation, two
// callers). This module adds no device/enrolment-code logic of its own -
// it forces tenantId to the signed-in owner's own tenant (never trusting a
// client-supplied value, unlike the ops DTO) and delegates the rest.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { DeviceListResult, DevicesService } from '../../ops'
import { setTenantContext } from '../menu/tenant-context'
import { AdminGenerateCodeDto } from './devices.dtos'

export interface DevicePairingView {
  id: string
  pairedPosId: string | null
}

export interface DeviceRevokeView {
  id: string
  status: 'revoked'
  revokedAt: string
}

@Injectable()
export class AdminDevicesService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly devices: DevicesService,
  ) {}

  private async assertOutlet(tenantId: string, outletId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
    })
  }

  async list(owner: AdminPrincipal, outletId: string): Promise<DeviceListResult> {
    await this.assertOutlet(owner.tenantId, outletId)
    // Same Prisma query DevicesService.list() runs for Platform Console's
    // fleet/tenant views, scoped one level further to this outlet.
    return this.devices.list({ tenantId: owner.tenantId, outletId })
  }

  async generateCode(owner: AdminPrincipal, outletId: string, dto: AdminGenerateCodeDto): Promise<{ code: string; deviceType: string; expiresAt: string }> {
    // The shared service itself 404s if outletId doesn't belong to tenantId
    // (see devices.service.ts generateCode) - that check, not a second one
    // here, is what proves the cross-tenant isolation test for this route.
    return this.devices.generateCode(owner, { tenantId: owner.tenantId, outletId, deviceType: dto.deviceType, reason: dto.reason })
  }

  /**
   * PATCH .../devices/:deviceId/pairing (issue #134): link a printer or card
   * terminal to one POS at this outlet (it then serves only that POS), or
   * back to the whole outlet with null. One printer and one terminal per POS.
   */
  async setPairing(owner: AdminPrincipal, outletId: string, deviceId: string, posDeviceId: string | null): Promise<DevicePairingView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const device = await tx.device.findFirst({ where: { id: deviceId, tenantId: owner.tenantId, outletId, status: 'active' } })
      if (!device) throw new NotFoundException({ code: 'not_found', message: 'No such active device at this outlet' })
      if (device.type !== 'printer' && device.type !== 'terminal') {
        throw new BadRequestException({ code: 'validation_failed', message: 'Only a printer or card terminal can be linked to a POS' })
      }

      if (posDeviceId) {
        const pos = await tx.device.findFirst({ where: { id: posDeviceId, tenantId: owner.tenantId, outletId, status: 'active', type: 'pos' } })
        if (!pos) throw new NotFoundException({ code: 'not_found', message: 'No such active POS at this outlet' })
        const taken = await tx.device.findFirst({
          where: { tenantId: owner.tenantId, type: device.type, status: 'active', pairedPosId: posDeviceId, id: { not: deviceId } },
          select: { label: true },
        })
        if (taken) {
          const kind = device.type === 'printer' ? 'printer' : 'card terminal'
          throw new ConflictException({ code: 'pos_already_linked', message: `${pos.label} already has a ${kind} linked (${taken.label}). Unlink it first.` })
        }
      }

      // Work already queued for this device falls back to the outlet-wide
      // queue, so a relink or unlink never strands a receipt or a payment.
      await tx.printJob.updateMany({ where: { tenantId: owner.tenantId, targetDeviceId: deviceId, printedAt: null }, data: { targetDeviceId: null } })
      await tx.paymentIntent.updateMany({
        where: { tenantId: owner.tenantId, targetDeviceId: deviceId, status: { in: ['created', 'pending'] } },
        data: { targetDeviceId: null },
      })
      const updated = await tx.device.update({ where: { id: deviceId }, data: { pairedPosId: posDeviceId } })
      return { id: updated.id, pairedPosId: updated.pairedPosId }
    })
  }

  /**
   * POST .../devices/:deviceId/revoke (issue #140): the owner's "Remove
   * device". Same write as the ops realm's revoke (status flips, the row and
   * its history stay - never a delete), scoped to the owner's tenant and the
   * outlet in the path, with the owner as the audit actor. Topology cleanup
   * in the same transaction: a revoked POS's linked printer/terminal fall
   * back to the outlet, and work still queued for the device goes to the
   * outlet-wide queue (same fallback setPairing above uses).
   */
  async revoke(owner: AdminPrincipal, outletId: string, deviceId: string, reason: string): Promise<DeviceRevokeView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const device = await tx.device.findFirst({ where: { id: deviceId, tenantId: owner.tenantId, outletId } })
      if (!device) throw new NotFoundException({ code: 'not_found', message: 'No such device at this outlet' })
      if (device.status === 'revoked') throw new ConflictException({ code: 'conflict', message: 'This device is already revoked' })

      await tx.device.updateMany({ where: { tenantId: owner.tenantId, pairedPosId: deviceId }, data: { pairedPosId: null } })
      await tx.printJob.updateMany({ where: { tenantId: owner.tenantId, targetDeviceId: deviceId, printedAt: null }, data: { targetDeviceId: null } })
      await tx.paymentIntent.updateMany({
        where: { tenantId: owner.tenantId, targetDeviceId: deviceId, status: { in: ['created', 'pending'] } },
        data: { targetDeviceId: null },
      })
      const revokedAt = new Date()
      const updated = await tx.device.update({ where: { id: deviceId }, data: { status: 'revoked', revokedAt, pairedPosId: null } })
      await tx.auditEvent.create({
        data: { tenantId: owner.tenantId, actorId: owner.id, actorEmail: owner.email, action: 'device.revoked', reason, occurredAt: revokedAt },
      })
      return { id: updated.id, status: 'revoked', revokedAt: revokedAt.toISOString() }
    })
  }
}
