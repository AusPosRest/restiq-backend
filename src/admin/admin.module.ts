import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { AdminAuthController } from './auth.controller'
import { AdminAuthService } from './auth.service'
import { AdminBrandingController } from './branding/branding.controller'
import { BrandingService } from './branding/branding.service'
import { AdminChecklistController } from './checklist/checklist.controller'
import { ChecklistService } from './checklist/checklist.service'
import { AdminMenuAllergensController } from './menu/allergens.controller'
import { AllergensService } from './menu/allergens.service'
import { AdminMenuCategoriesController } from './menu/categories.controller'
import { CategoriesService } from './menu/categories.service'
import { AdminMenuCombosController } from './menu/combos.controller'
import { CombosService } from './menu/combos.service'
import { AdminMenuItemsController } from './menu/items.controller'
import { ItemsService } from './menu/items.service'
import { AdminMenuModifierGroupsController } from './menu/modifier-groups.controller'
import { ModifierGroupsService } from './menu/modifier-groups.service'
import { PricesService } from './menu/prices.service'
import { AdminMenuImportController } from './menu-import/menu-import.controller'
import { MenuImportService } from './menu-import/menu-import.service'
import { AdminOutletsController } from './outlets/outlets.controller'
import { OutletsService } from './outlets/outlets.service'

@Module({
  imports: [PlatformModule],
  controllers: [
    AdminAuthController,
    AdminChecklistController,
    AdminMenuImportController,
    AdminMenuCategoriesController,
    AdminMenuItemsController,
    AdminMenuModifierGroupsController,
    AdminMenuAllergensController,
    AdminMenuCombosController,
    AdminOutletsController,
    AdminBrandingController,
  ],
  providers: [
    AdminAuthService,
    ChecklistService,
    MenuImportService,
    CategoriesService,
    ItemsService,
    PricesService,
    ModifierGroupsService,
    AllergensService,
    CombosService,
    OutletsService,
    BrandingService,
  ],
})
export class AdminModule {}
