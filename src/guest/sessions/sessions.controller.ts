import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal, Public } from '../../platform'
import { GuestSessionsService } from './sessions.service'
import { JoinSessionDto, OutletAvailability, SessionJoinResult, SessionStartResult, StartSessionDto, TableSessionView } from './sessions.dtos'

@Controller('guest/v1')
export class GuestSessionsController {
  constructor(private readonly sessions: GuestSessionsService) {}

  // CAP-1 capability gate check, pre-auth - reads the same OutletCapability
  // row start/join enforce server-side (never a client-trusted shortcut, see
  // sessions.service.ts's assertQrOrderingEnabled).
  @Public()
  @Get('outlets/:outletId/availability')
  checkAvailability(@Param('outletId') outletId: string): Promise<OutletAvailability> {
    return this.sessions.checkAvailability(outletId)
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
  joinSession(@Body() dto: JoinSessionDto): Promise<SessionJoinResult> {
    return this.sessions.joinSession(dto)
  }

  @Get('session')
  getCurrentSession(@CurrentGuest() guest: GuestPrincipal): Promise<TableSessionView> {
    return this.sessions.getCurrentSession(guest)
  }
}
