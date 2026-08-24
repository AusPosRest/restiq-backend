import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import {
  CreateItemDto,
  CreatePriceDto,
  CreateVariantDto,
  CurrentPriceQueryDto,
  CurrentPriceView,
  ItemPriceView,
  ItemView,
  ReplaceAllergensDto,
  ReplaceModifierGroupsDto,
  SetAvailabilityDto,
  SetOutletAvailabilityDto,
  UpdateItemDto,
} from './items.dtos'
import { ItemsService } from './items.service'
import { PricesService } from './prices.service'

@Controller('admin/v1/menu/items')
export class AdminMenuItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly prices: PricesService,
  ) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal, @Query('categoryId') categoryId?: string): Promise<ItemView[]> {
    return this.items.list(owner, categoryId)
  }

  @Get(':itemId')
  get(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string): Promise<ItemView> {
    return this.items.get(owner, itemId)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateItemDto): Promise<ItemView> {
    return this.items.create(owner, dto)
  }

  @Patch(':itemId')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: UpdateItemDto): Promise<ItemView> {
    return this.items.update(owner, itemId, dto)
  }

  // 86 toggle - immediate, reflected in this same response.
  @Patch(':itemId/availability')
  setAvailability(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: SetAvailabilityDto): Promise<ItemView> {
    return this.items.setAvailability(owner, itemId, dto.available)
  }

  @Post(':itemId/variants')
  @HttpCode(201)
  addVariant(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: CreateVariantDto): Promise<ItemView> {
    return this.items.addVariant(owner, itemId, dto)
  }

  @Delete(':itemId/variants/:variantId')
  removeVariant(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Param('variantId') variantId: string): Promise<ItemView> {
    return this.items.removeVariant(owner, itemId, variantId)
  }

  @Put(':itemId/modifier-groups')
  replaceModifierGroups(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: ReplaceModifierGroupsDto): Promise<ItemView> {
    return this.items.replaceModifierGroups(owner, itemId, dto.modifierGroupIds)
  }

  @Put(':itemId/allergens')
  replaceAllergens(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: ReplaceAllergensDto): Promise<ItemView> {
    return this.items.replaceAllergens(owner, itemId, dto.allergenIds)
  }

  @Put(':itemId/outlets/:outletId/availability')
  setOutletAvailability(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('itemId') itemId: string,
    @Param('outletId') outletId: string,
    @Body() dto: SetOutletAvailabilityDto,
  ): Promise<{ itemId: string; outletId: string; available: boolean }> {
    return this.items.setOutletAvailability(owner, itemId, outletId, dto.available)
  }

  @Delete(':itemId/outlets/:outletId/availability')
  @HttpCode(204)
  clearOutletAvailability(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Param('outletId') outletId: string): Promise<void> {
    return this.items.clearOutletAvailability(owner, itemId, outletId)
  }

  // AD-11: insert-only - see prices.service.ts.
  @Post(':itemId/prices')
  @HttpCode(201)
  createPrice(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Body() dto: CreatePriceDto): Promise<ItemPriceView> {
    return this.prices.create(owner, itemId, dto)
  }

  // The load-bearing current-price read (menu/pricing.ts): most recent row
  // with effectiveAt <= now, never a future-scheduled one.
  @Get(':itemId/price')
  currentPrice(@CurrentOwner() owner: AdminPrincipal, @Param('itemId') itemId: string, @Query() query: CurrentPriceQueryDto): Promise<CurrentPriceView> {
    return this.prices.currentPrice(owner, itemId, query)
  }
}
