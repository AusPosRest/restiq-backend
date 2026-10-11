// PE-21: the kitchen stations an item can be routed to, for the owner's item
// editor (PATCH .../items/:id/station writes the route). Read-only - stations
// themselves come from each outlet's starter setup.
import { Controller, Get } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { ItemsService, MenuStationView } from './items.service'

@Controller('admin/v1/menu/stations')
export class AdminMenuStationsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<MenuStationView[]> {
    return this.items.listStations(owner)
  }
}
