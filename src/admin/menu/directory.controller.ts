// Product directory, owner side (#153): browse the platform catalog (only
// products priced in this tenant's currency) and copy a selection into the
// tenant's own menu.
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { CatalogProductView, CatalogService, ImportCatalogProductsDto } from '../../ops'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CommitItemsResult } from './commit-items'

@Controller('admin/v1/menu/directory')
export class AdminMenuDirectoryController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal, @Query('q') q?: string, @Query('tag') tag?: string): Promise<{ products: CatalogProductView[] }> {
    return this.catalog.listForTenant(owner, { q, tag })
  }

  @Get('tags')
  tags(@CurrentOwner() owner: AdminPrincipal): Promise<{ tags: string[] }> {
    return this.catalog.tagsForTenant(owner)
  }

  @Post('import')
  @HttpCode(201)
  import(@CurrentOwner() owner: AdminPrincipal, @Body() dto: ImportCatalogProductsDto): Promise<CommitItemsResult> {
    return this.catalog.importForTenant(owner, dto.productIds)
  }
}
