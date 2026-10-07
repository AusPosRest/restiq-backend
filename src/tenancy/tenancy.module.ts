import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { PublicTenantController } from './public-tenant.controller'

@Module({ imports: [PlatformModule], controllers: [PublicTenantController] })
export class TenancyModule {}
