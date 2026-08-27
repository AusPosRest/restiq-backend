import { Controller, Get } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { MenuView } from './menu.dtos'
import { MenuService } from './menu.service'

@Controller('pos/v1')
export class PosMenuController {
  constructor(private readonly menu: MenuService) {}

  // No outlet param - the catalog itself (categories/items) is tenant-wide,
  // not per-outlet; only each item's availability override is scoped to the
  // calling staff's own outlet (PosPrincipal.outletId), same
  // single-outlet-per-device posture every other pos/* read already assumes.
  @Get('menu')
  getMenu(@CurrentStaff() staff: PosPrincipal): Promise<MenuView> {
    return this.menu.getMenu(staff)
  }
}
