import { IsBoolean } from 'class-validator'
import type { OutletType } from '../../generated/prisma/client'

export interface OutletView {
  id: string
  name: string
  address: string
  type: OutletType
  timezone: string
}

export interface CapabilityView {
  key: string
  enabled: boolean
}

export class SetCapabilityDto {
  @IsBoolean()
  enabled!: boolean
}
