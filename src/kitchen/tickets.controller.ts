import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../platform'
import { AllDaySummaryEntryView, ExpoOrderView, StationView, TicketView } from './tickets.dtos'
import { BumpedTicketView, KitchenTicketsService } from './tickets.service'

// kitchen-display/CAP-1..5 (issue #67, AD-16): rides the existing pos realm
// (aud "pos", same PosPrincipal/staff PIN population) - no new auth realm.
// Mounted at /kitchen/v1 rather than under /pos/v1: PosAuthGuard's route
// match is extended to cover it (see platform/pos-auth.guard.ts), the
// smaller of the two surgery options named in issue #67's scope.
@Controller('kitchen/v1')
export class KitchenController {
  constructor(private readonly tickets: KitchenTicketsService) {}

  @Get('outlets/:outletId/stations')
  listStations(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<StationView[]> {
    return this.tickets.listStations(staff, outletId)
  }

  // :stationId accepts a real station id or the literal "unrouted" - the
  // synthetic grouping for tickets fired when the outlet had zero stations.
  @Get('outlets/:outletId/stations/:stationId/queue')
  stationQueue(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string, @Param('stationId') stationId: string): Promise<TicketView[]> {
    return this.tickets.stationQueue(staff, outletId, stationId)
  }

  @Get('outlets/:outletId/expo')
  expo(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<ExpoOrderView[]> {
    return this.tickets.expo(staff, outletId)
  }

  @Get('outlets/:outletId/bumped')
  bumped(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<BumpedTicketView[]> {
    return this.tickets.bumped(staff, outletId)
  }

  @Get('outlets/:outletId/all-day-summary')
  allDaySummary(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<AllDaySummaryEntryView[]> {
    return this.tickets.allDaySummary(staff, outletId)
  }

  @Post('tickets/:ticketId/bump')
  @HttpCode(200)
  bump(@CurrentStaff() staff: PosPrincipal, @Param('ticketId') ticketId: string): Promise<TicketView> {
    return this.tickets.bump(staff, ticketId)
  }

  @Post('tickets/:ticketId/recall')
  @HttpCode(200)
  recall(@CurrentStaff() staff: PosPrincipal, @Param('ticketId') ticketId: string): Promise<TicketView> {
    return this.tickets.recall(staff, ticketId)
  }

  @Post('tickets/:ticketId/refire')
  @HttpCode(200)
  refire(@CurrentStaff() staff: PosPrincipal, @Param('ticketId') ticketId: string): Promise<TicketView> {
    return this.tickets.refire(staff, ticketId)
  }
}
