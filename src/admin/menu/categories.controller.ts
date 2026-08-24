import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CategoryView, CreateCategoryDto, UpdateCategoryDto } from './categories.dtos'
import { CategoriesService } from './categories.service'

@Controller('admin/v1/menu/categories')
export class AdminMenuCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<CategoryView[]> {
    return this.categories.list(owner)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateCategoryDto): Promise<CategoryView> {
    return this.categories.create(owner, dto)
  }

  @Patch(':categoryId')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('categoryId') categoryId: string, @Body() dto: UpdateCategoryDto): Promise<CategoryView> {
    return this.categories.update(owner, categoryId, dto)
  }

  @Delete(':categoryId')
  @HttpCode(204)
  remove(@CurrentOwner() owner: AdminPrincipal, @Param('categoryId') categoryId: string): Promise<void> {
    return this.categories.remove(owner, categoryId)
  }
}
