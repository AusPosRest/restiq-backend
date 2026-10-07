// Offline sync device realm (restiq-backend#185, docs/SYNC-DESIGN.md §9): the
// sixth disjoint realm. /sync/v1/* is called by a hub till on behalf of its
// outlet, not by a staff member, so there is no token: every request is
// signed with the device's ed25519 key (see device-signature.ts). Same global,
// early-return-outside-the-prefix shape as the other realm guards.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import type { Request } from 'express'
import { parseEd25519PublicKey, SIGNATURE_SKEW_MS, signingString, verifyDeviceSignature } from './device-signature'
import { RegionRegistryService } from './region-registry.service'
import { isTenantBlocked } from './tenant-lifecycle'

export interface DevicePrincipal {
  deviceId: string
  tenantId: string
  outletId: string
}

type SyncRequest = Request & { device?: DevicePrincipal; rawBody?: Buffer }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Injects the guard-verified device into a /sync/v1 handler parameter. */
export const CurrentDevice = createParamDecorator((_data: unknown, context: ExecutionContext): DevicePrincipal => {
  const { device } = context.switchToHttp().getRequest<SyncRequest>()
  if (!device) throw new UnauthorizedException({ code: 'invalid_signature', message: 'A signed device request is required' })
  return device
})

function refuse(): never {
  // One answer for every failure, so a caller learns nothing about which part was wrong.
  throw new UnauthorizedException({ code: 'invalid_signature', message: 'A signed device request is required' })
}

@Injectable()
export class DeviceSyncGuard implements CanActivate {
  constructor(private readonly registry: RegionRegistryService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SyncRequest>()
    if (!request.path.startsWith('/sync/')) return true

    const deviceId = request.header('x-device-id')
    const timestamp = request.header('x-device-timestamp')
    const signature = request.header('x-device-signature')
    if (!deviceId || !UUID.test(deviceId) || !timestamp || !/^\d{1,15}$/.test(timestamp) || !signature) refuse()
    // issue #195: a till with the wrong time is the commonest failure, and staff
    // can fix it - so this one case says what is wrong. It is checked before any
    // database read, so it reveals nothing about devices; everything else keeps
    // the single generic answer.
    if (Math.abs(Date.now() - Number(timestamp)) > SIGNATURE_SKEW_MS) {
      throw new UnauthorizedException({
        code: 'clock_skew',
        message: "This device's clock is too far from RESTIQ's time. Set the correct time and try again.",
        serverTime: new Date().toISOString(),
      })
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    // The tenant is not known until the device row is read, so the read uses
    // the same operator_read policy the ops console reads devices with.
    const device = await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      return tx.device.findUnique({ where: { id: deviceId }, select: { tenantId: true, outletId: true, status: true, publicKey: true } })
    })
    const key = device?.publicKey ? parseEd25519PublicKey(device.publicKey) : null
    if (!device || !key) refuse()
    if (!verifyDeviceSignature(key, signingString(request.method, request.originalUrl, timestamp, request.rawBody), signature)) refuse()

    if (device.status !== 'active') {
      throw new ForbiddenException({ code: 'device_revoked', message: 'This device has been revoked' })
    }
    if (!device.outletId) {
      throw new ForbiddenException({ code: 'device_not_in_outlet', message: 'This device does not belong to an outlet' })
    }
    if (await isTenantBlocked(this.registry, device.tenantId)) {
      throw new ForbiddenException({ code: 'tenant_inactive', message: 'This tenant is no longer active' })
    }

    await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${device.tenantId}, true)`
      await tx.device.update({ where: { id: deviceId }, data: { lastContactAt: new Date() } })
    })
    request.device = { deviceId, tenantId: device.tenantId, outletId: device.outletId }
    return true
  }
}
