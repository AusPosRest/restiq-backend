import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import {
  CreateFloorDto,
  CreatePrinterDto,
  CreateStationDto,
  CreateTableDto,
  FloorPlanView,
  FloorView,
  PrinterView,
  StationView,
  TableView,
  UpdateFloorDto,
  UpdatePrinterDto,
  UpdateStationDto,
  UpdateTableDto,
} from './floor-plan.dtos'
import { FloorPlanService } from './floor-plan.service'

@Controller('admin/v1/outlets/:outletId/floor-plan')
export class AdminFloorPlanController {
  constructor(private readonly floorPlan: FloorPlanService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string): Promise<FloorPlanView> {
    return this.floorPlan.getFloorPlan(owner, outletId)
  }

  @Post('floors')
  @HttpCode(201)
  createFloor(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Body() dto: CreateFloorDto): Promise<FloorView> {
    return this.floorPlan.createFloor(owner, outletId, dto)
  }

  @Patch('floors/:floorId')
  updateFloor(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Param('floorId') floorId: string,
    @Body() dto: UpdateFloorDto,
  ): Promise<FloorView> {
    return this.floorPlan.updateFloor(owner, outletId, floorId, dto)
  }

  @Delete('floors/:floorId')
  @HttpCode(204)
  deleteFloor(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Param('floorId') floorId: string): Promise<void> {
    return this.floorPlan.deleteFloor(owner, outletId, floorId)
  }

  @Post('tables')
  @HttpCode(201)
  createTable(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Body() dto: CreateTableDto): Promise<TableView> {
    return this.floorPlan.createTable(owner, outletId, dto)
  }

  @Patch('tables/:tableId')
  updateTable(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Param('tableId') tableId: string,
    @Body() dto: UpdateTableDto,
  ): Promise<TableView> {
    return this.floorPlan.updateTable(owner, outletId, tableId, dto)
  }

  @Delete('tables/:tableId')
  @HttpCode(204)
  deleteTable(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Param('tableId') tableId: string): Promise<void> {
    return this.floorPlan.deleteTable(owner, outletId, tableId)
  }

  @Get('printers')
  listPrinters(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string): Promise<PrinterView[]> {
    return this.floorPlan.listPrinters(owner, outletId)
  }

  @Post('printers')
  @HttpCode(201)
  createPrinter(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Body() dto: CreatePrinterDto): Promise<PrinterView> {
    return this.floorPlan.createPrinter(owner, outletId, dto)
  }

  @Patch('printers/:printerId')
  updatePrinter(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Param('printerId') printerId: string,
    @Body() dto: UpdatePrinterDto,
  ): Promise<PrinterView> {
    return this.floorPlan.updatePrinter(owner, outletId, printerId, dto)
  }

  @Post('stations')
  @HttpCode(201)
  createStation(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Body() dto: CreateStationDto): Promise<StationView> {
    return this.floorPlan.createStation(owner, outletId, dto)
  }

  @Patch('stations/:stationId')
  updateStation(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Param('stationId') stationId: string,
    @Body() dto: UpdateStationDto,
  ): Promise<StationView> {
    return this.floorPlan.updateStation(owner, outletId, stationId, dto)
  }
}
