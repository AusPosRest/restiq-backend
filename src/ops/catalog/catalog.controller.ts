import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { CatalogProductView, CreateCatalogProductDto, UpdateCatalogProductDto } from './catalog.dtos'
import { CatalogService } from './catalog.service'

@Controller('ops/v1/catalog/products')
export class OpsCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@Query('q') q?: string, @Query('tag') tag?: string, @Query('currency') currency?: string): Promise<{ products: CatalogProductView[] }> {
    return this.catalog.list({ q, tag, currency })
  }

  @Get('tags')
  tags(@Query('currency') currency?: string): Promise<{ tags: string[] }> {
    return this.catalog.tags(currency)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOperator() operator: OpsPrincipal, @Body() dto: CreateCatalogProductDto): Promise<{ product: CatalogProductView }> {
    return this.catalog.create(operator, dto)
  }

  @Patch(':id')
  update(@CurrentOperator() operator: OpsPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCatalogProductDto): Promise<{ product: CatalogProductView }> {
    return this.catalog.update(operator, id, dto)
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentOperator() operator: OpsPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('reason') reason?: string): Promise<void> {
    return this.catalog.remove(operator, id, reason)
  }
}
