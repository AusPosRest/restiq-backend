import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common'
import { ClientIp, CurrentGuest, GuestPrincipal, Public } from '../../platform'
import { GuestSessionsService } from './sessions.service'
import { AvailabilityQueryDto, JoinSessionDto, KioskSessionStartResult, OutletAvailability, SessionJoinResult, SessionStartResult, StartKioskSessionDto, StartSessionDto, TableSessionView, TableWelcomeView } from './sessions.dtos'

@Controller('guest/v1')
export class GuestSessionsController {
  constructor(private readonly sessions: GuestSessionsService) {}

  // CAP-1 capability gate check, pre-auth - reads the same OutletCapability
  // row start/join enforce server-side (never a client-trusted shortcut, see
  // sessions.service.ts's assertQrOrderingEnabled).
  @Public()
  @Get('outlets/:outletId/availability')
  checkAvailability(@Param('outletId') outletId: string, @Query() query: AvailabilityQueryDto): Promise<OutletAvailability> {
    return this.sessions.checkAvailability(outletId, query.tableId)
  }

  @Public()
  @Post('sessions')
  @HttpCode(201)
  startSession(@Body() dto: StartSessionDto): Promise<SessionStartResult> {
    return this.sessions.startSession(dto)
  }

  @Public()
  @Post('sessions/join')
  @HttpCode(200)
  joinSession(@Body() dto: JoinSessionDto, @ClientIp() ip: string): Promise<SessionJoinResult> {
    return this.sessions.joinSession(dto, ip)
  }

  // Issue #138: a kiosk tab's table-less session, bound to its enrolled device.
  @Public()
  @Post('kiosk/sessions')
  @HttpCode(201)
  startKioskSession(@Body() dto: StartKioskSessionDto): Promise<KioskSessionStartResult> {
    return this.sessions.startKioskSession(dto)
  }

  @Get('session')
  getCurrentSession(@CurrentGuest() guest: GuestPrincipal): Promise<TableSessionView> {
    return this.sessions.getCurrentSession(guest)
  }

  // CU-22/PE-24: the restaurant and table a QR scan points at, for the welcome screen.
  @Public()
  @Get('outlets/:outletId/tables/:tableId/welcome')
  getTableWelcome(@Param('outletId', ParseUUIDPipe) outletId: string, @Param('tableId', ParseUUIDPipe) tableId: string): Promise<TableWelcomeView> {
    return this.sessions.getTableWelcome(outletId, tableId)
  }
}
