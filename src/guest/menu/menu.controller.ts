// qr-self-order/CAP-2 (stories.yaml story 2): guest-readable menu. Both
// routes require a guest token (GuestAuthGuard, AD-17) - no @Public() here,
// unlike sessions.controller.ts's pre-auth availability check, because the
// outlet the menu is scoped to comes from the guest principal itself, not a
// client-supplied param.
import { Controller, Get, Param } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { GuestMenuView, MenuItemView } from './menu.dtos'
import { GuestMenuService } from './menu.service'

@Controller('guest/v1/menu')
export class GuestMenuController {
  constructor(private readonly menu: GuestMenuService) {}

  @Get()
  getMenu(@CurrentGuest() guest: GuestPrincipal): Promise<GuestMenuView> {
    return this.menu.getMenu(guest)
  }

  // Q4 Item Detail (stories.yaml story 2): a separate read so tapping into
  // one item's detail screen doesn't require re-fetching the whole menu -
  // the same shape as a MenuItemView within GuestMenuView.categories[].items,
  // just addressed directly by id.
  @Get('items/:itemId')
  getItem(@CurrentGuest() guest: GuestPrincipal, @Param('itemId') itemId: string): Promise<MenuItemView> {
    return this.menu.getItem(guest, itemId)
  }
}
