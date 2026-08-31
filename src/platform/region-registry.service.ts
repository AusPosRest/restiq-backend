// AD-1 + AD-9: writes route to the tenant's owning region through the
// control-plane registry. v1 deploys one data plane (Mumbai) that shares this
// database - but every caller still resolves its plane through this service,
// so a second region is configuration, not new code paths.
import { Injectable } from '@nestjs/common'
import type { PrismaClient } from '../db/client'
import { PrismaService } from './prisma.service'

const HOME_REGION_DEFAULT = 'in-mumbai'

@Injectable()
export class RegionRegistryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The region newly provisioned tenants are homed in. */
  homeRegion(): string {
    return process.env.HOME_REGION ?? HOME_REGION_DEFAULT
  }

  /** The data-plane client for a region. v1: only the home region exists. */
  planeFor(region: string): PrismaClient {
    if (region !== this.homeRegion()) {
      throw new Error(`No data plane is deployed for region "${region}"`)
    }
    return this.prisma.client
  }
}
