import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { DeviceListResult, DevicesService, DeviceView } from './devices.service'
import { EnrollDeviceDto, GenerateCodeDto, HeartbeatDto, HubDto, RevokeDto } from './devices.dtos'

@Controller('ops/v1/devices')
export class OpsDevicesController {
  constructor(private readonly devices: DevicesService) {}

  // Fleet-wide by default; ?tenantId=... scopes it to one tenant (Tenant
  // Detail's Devices tab reuses this same read).
  @Get()
  list(@Query() query: Record<string, string | undefined>): Promise<DeviceListResult> {
    return this.devices.list(query)
  }

  @Post('enrolment-codes')
  @HttpCode(201)
  generateCode(
    @CurrentOperator() operator: OpsPrincipal,
    @Body() dto: GenerateCodeDto,
  ): Promise<{ code: string; deviceType: string; expiresAt: string }> {
    return this.devices.generateCode(operator, dto)
  }

  @Post('enroll')
  @HttpCode(201)
  enroll(@CurrentOperator() operator: OpsPrincipal, @Body() dto: EnrollDeviceDto): Promise<{ device: DeviceView }> {
    return this.devices.enroll(operator, dto)
  }

  @Put(':id/hub')
  designateHub(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HubDto,
  ): Promise<{ device: DeviceView; displacedDeviceId: string | null }> {
    return this.devices.designateHub(operator, id, dto.reason)
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeDto,
  ): Promise<{ device: DeviceView }> {
    return this.devices.revoke(operator, id, dto.reason)
  }

  // CAP-6: a device's heartbeat. No device client exists yet (see
  // devices.service.ts) - reachable with an ops token as a testable stub
  // until a device-key auth scheme lands with the real sync protocol.
  @Post(':id/heartbeat')
  @HttpCode(200)
  heartbeat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HeartbeatDto): Promise<{ device: DeviceView }> {
    return this.devices.heartbeat(id, dto)
  }
}
