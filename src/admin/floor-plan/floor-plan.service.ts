// CAP-5 floor plan & stations. Floors/tables are outlet-scoped through their
// floor; stations/printers are outlet-scoped directly (see schema comment).
//
// Overlap policy (SPEC open question - no stated product decision, left to
// the builder's judgment): REJECT with 409, not auto-adjust. Auto-adjust
// needs a placement algorithm (where does the server move it? how far?) that
// the design doesn't specify, and a silently-relocated table is a worse
// surprise for an owner mid-edit than an immediate "that spot is taken" the
// UI can show right where they dropped it. Overlap is bounding-box
// intersection (works uniformly for circle/square/rectangle - the editor is
// grid-based, not a physics simulation) with strict inequality, so tables
// may share an edge without colliding.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { ChecklistService } from '../checklist/checklist.service'
import { setTenantContext } from '../menu/tenant-context'
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

type Tx = Prisma.TransactionClient

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function toTableView(t: { id: string; floorId: string; label: string; x: number; y: number; width: number; height: number; shape: string; seatCapacity: number }): TableView {
  return { id: t.id, floorId: t.floorId, label: t.label, x: t.x, y: t.y, width: t.width, height: t.height, shape: t.shape as TableView['shape'], seatCapacity: t.seatCapacity }
}

function toPrinterView(p: { id: string; outletId: string; name: string; renderMode: string }): PrinterView {
  return { id: p.id, outletId: p.outletId, name: p.name, renderMode: p.renderMode as PrinterView['renderMode'] }
}

function toStationView(s: { id: string; outletId: string; name: string; ageingThresholdMinutes: number; primaryPrinterId: string | null; fallbackPrinterId: string | null }): StationView {
  return { id: s.id, outletId: s.outletId, name: s.name, ageingThresholdMinutes: s.ageingThresholdMinutes, primaryPrinterId: s.primaryPrinterId, fallbackPrinterId: s.fallbackPrinterId }
}

async function loadOutlet(tx: Tx, tenantId: string, outletId: string): Promise<void> {
  const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
  if (!outlet || outlet.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
  }
}

async function loadFloor(tx: Tx, tenantId: string, outletId: string, floorId: string) {
  const floor = await tx.floor.findUnique({ where: { id: floorId } })
  if (!floor || floor.tenantId !== tenantId || floor.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such floor' })
  }
  return floor
}

async function loadTable(tx: Tx, tenantId: string, outletId: string, tableId: string) {
  const table = await tx.diningTable.findUnique({ where: { id: tableId } })
  if (!table || table.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such table' })
  }
  await loadFloor(tx, tenantId, outletId, table.floorId)
  return table
}

async function loadPrinter(tx: Tx, tenantId: string, outletId: string, printerId: string) {
  const printer = await tx.printer.findUnique({ where: { id: printerId } })
  if (!printer || printer.tenantId !== tenantId || printer.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such printer' })
  }
  return printer
}

async function loadStation(tx: Tx, tenantId: string, outletId: string, stationId: string) {
  const station = await tx.station.findUnique({ where: { id: stationId } })
  if (!station || station.tenantId !== tenantId || station.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such station' })
  }
  return station
}

/** A printer must belong to the same tenant and outlet as the station referencing it. */
async function assertPrinterInOutlet(tx: Tx, tenantId: string, outletId: string, printerId: string): Promise<void> {
  const printer = await tx.printer.findUnique({ where: { id: printerId } })
  if (!printer || printer.tenantId !== tenantId || printer.outletId !== outletId) {
    throw new BadRequestException({ code: 'validation_failed', message: 'No such printer for this outlet' })
  }
}

async function assertNoOverlap(tx: Tx, tenantId: string, floorId: string, bounds: Bounds, excludeTableId?: string): Promise<void> {
  const others = await tx.diningTable.findMany({
    where: { tenantId, floorId, ...(excludeTableId ? { id: { not: excludeTableId } } : {}) },
  })
  if (others.some((other) => boundsOverlap(bounds, other))) {
    throw new ConflictException({ code: 'table_overlap', message: 'This table overlaps another table on the same floor' })
  }
}

@Injectable()
export class FloorPlanService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly checklist: ChecklistService,
  ) {}

  async getFloorPlan(owner: AdminPrincipal, outletId: string): Promise<FloorPlanView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadOutlet(tx, owner.tenantId, outletId)

      const floors = await tx.floor.findMany({
        where: { outletId, deletedAt: null },
        include: { tables: { orderBy: { createdAt: 'asc' } } },
        orderBy: { sortOrder: 'asc' },
      })
      const stations = await tx.station.findMany({ where: { outletId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
      const printers = await tx.printer.findMany({ where: { outletId, deletedAt: null }, orderBy: { createdAt: 'asc' } })

      const floorViews: FloorView[] = floors.map((f) => ({
        id: f.id,
        outletId: f.outletId,
        name: f.name,
        sortOrder: f.sortOrder,
        tables: f.tables.map(toTableView),
      }))

      return { floors: floorViews, stations: stations.map(toStationView), printers: printers.map(toPrinterView) }
    })
  }

  async createFloor(owner: AdminPrincipal, outletId: string, dto: CreateFloorDto): Promise<FloorView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadOutlet(tx, owner.tenantId, outletId)
      const floor = await tx.floor.create({ data: { tenantId: owner.tenantId, outletId, name: dto.name, sortOrder: dto.sortOrder ?? 0 } })
      return { id: floor.id, outletId: floor.outletId, name: floor.name, sortOrder: floor.sortOrder, tables: [] }
    })
  }

  async updateFloor(owner: AdminPrincipal, outletId: string, floorId: string, dto: UpdateFloorDto): Promise<FloorView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await loadFloor(tx, owner.tenantId, outletId, floorId)
      const floor = await tx.floor.update({
        where: { id: floorId },
        data: { name: dto.name ?? existing.name, sortOrder: dto.sortOrder ?? existing.sortOrder },
      })
      const tables = await tx.diningTable.findMany({ where: { floorId }, orderBy: { createdAt: 'asc' } })
      return { id: floor.id, outletId: floor.outletId, name: floor.name, sortOrder: floor.sortOrder, tables: tables.map(toTableView) }
    })
  }

  async deleteFloor(owner: AdminPrincipal, outletId: string, floorId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadFloor(tx, owner.tenantId, outletId, floorId)
      const tableCount = await tx.diningTable.count({ where: { floorId } })
      if (tableCount > 0) {
        throw new ConflictException({ code: 'floor_has_tables', message: 'This floor still has tables. Remove them first.' })
      }
      await tx.floor.delete({ where: { id: floorId } })
    })
  }

  async createTable(owner: AdminPrincipal, outletId: string, dto: CreateTableDto): Promise<TableView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    const bounds: Bounds = { x: dto.x, y: dto.y, width: dto.width, height: dto.height }

    let isFirstTableForOutlet = false
    const table = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadFloor(tx, owner.tenantId, outletId, dto.floorId)
      await assertNoOverlap(tx, owner.tenantId, dto.floorId, bounds)

      isFirstTableForOutlet = (await tx.diningTable.count({ where: { tenantId: owner.tenantId, floor: { outletId } } })) === 0

      return tx.diningTable.create({
        data: {
          tenantId: owner.tenantId,
          floorId: dto.floorId,
          label: dto.label,
          x: dto.x,
          y: dto.y,
          width: dto.width,
          height: dto.height,
          shape: dto.shape,
          seatCapacity: dto.seatCapacity,
        },
      })
    })

    // Outside the transaction, same reasoning as menu-import's checklist
    // call: interactive transactions don't compose, and this story's
    // atomicity guarantee covers the table write, not the checklist flag.
    if (isFirstTableForOutlet) {
      await this.checklist.updateStep(owner.tenantId, 'floor_plan', true)
    }

    return toTableView(table)
  }

  async updateTable(owner: AdminPrincipal, outletId: string, tableId: string, dto: UpdateTableDto): Promise<TableView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await loadTable(tx, owner.tenantId, outletId, tableId)
      const bounds: Bounds = {
        x: dto.x ?? existing.x,
        y: dto.y ?? existing.y,
        width: dto.width ?? existing.width,
        height: dto.height ?? existing.height,
      }
      await assertNoOverlap(tx, owner.tenantId, existing.floorId, bounds, tableId)

      const table = await tx.diningTable.update({
        where: { id: tableId },
        data: {
          label: dto.label ?? existing.label,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          shape: dto.shape ?? existing.shape,
          seatCapacity: dto.seatCapacity ?? existing.seatCapacity,
        },
      })
      return toTableView(table)
    })
  }

  async deleteTable(owner: AdminPrincipal, outletId: string, tableId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadTable(tx, owner.tenantId, outletId, tableId)
      await tx.diningTable.delete({ where: { id: tableId } })
    })
  }

  async createPrinter(owner: AdminPrincipal, outletId: string, dto: CreatePrinterDto): Promise<PrinterView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadOutlet(tx, owner.tenantId, outletId)
      const printer = await tx.printer.create({ data: { tenantId: owner.tenantId, outletId, name: dto.name, renderMode: dto.renderMode } })
      return toPrinterView(printer)
    })
  }

  // tenant-admin/CAP-6: printers scoped to one outlet, without the rest of
  // the floor plan (floors/tables/stations) getFloorPlan() also returns.
  async listPrinters(owner: AdminPrincipal, outletId: string): Promise<PrinterView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadOutlet(tx, owner.tenantId, outletId)
      const printers = await tx.printer.findMany({ where: { outletId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
      return printers.map(toPrinterView)
    })
  }

  // Render-mode only - a printer's fallback is Station.fallbackPrinterId,
  // already mutable via updateStation.
  async updatePrinter(owner: AdminPrincipal, outletId: string, printerId: string, dto: UpdatePrinterDto): Promise<PrinterView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadPrinter(tx, owner.tenantId, outletId, printerId)
      const printer = await tx.printer.update({ where: { id: printerId }, data: { renderMode: dto.renderMode } })
      return toPrinterView(printer)
    })
  }

  async createStation(owner: AdminPrincipal, outletId: string, dto: CreateStationDto): Promise<StationView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadOutlet(tx, owner.tenantId, outletId)

      const primaryPrinterId = dto.primaryPrinterId ?? null
      if (primaryPrinterId === null && dto.noPrinterAcknowledged !== true) {
        throw new BadRequestException({
          code: 'printer_required',
          message: 'A station needs a printer, or noPrinterAcknowledged: true to confirm it intentionally has none',
        })
      }
      if (primaryPrinterId) await assertPrinterInOutlet(tx, owner.tenantId, outletId, primaryPrinterId)
      if (dto.fallbackPrinterId) await assertPrinterInOutlet(tx, owner.tenantId, outletId, dto.fallbackPrinterId)

      const station = await tx.station.create({
        data: {
          tenantId: owner.tenantId,
          outletId,
          name: dto.name,
          ageingThresholdMinutes: dto.ageingThresholdMinutes,
          primaryPrinterId,
          fallbackPrinterId: dto.fallbackPrinterId ?? null,
        },
      })
      return toStationView(station)
    })
  }

  async updateStation(owner: AdminPrincipal, outletId: string, stationId: string, dto: UpdateStationDto): Promise<StationView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await loadStation(tx, owner.tenantId, outletId, stationId)

      // primaryPrinterId undefined = untouched; present (string or null) =
      // this request is setting the effective value.
      const primaryPrinterId = dto.primaryPrinterId !== undefined ? dto.primaryPrinterId : existing.primaryPrinterId
      if (primaryPrinterId === null && dto.noPrinterAcknowledged !== true) {
        throw new BadRequestException({
          code: 'printer_required',
          message: 'A station needs a printer, or noPrinterAcknowledged: true to confirm it intentionally has none',
        })
      }
      if (primaryPrinterId) await assertPrinterInOutlet(tx, owner.tenantId, outletId, primaryPrinterId)

      const fallbackPrinterId = dto.fallbackPrinterId !== undefined ? dto.fallbackPrinterId : existing.fallbackPrinterId
      if (fallbackPrinterId) await assertPrinterInOutlet(tx, owner.tenantId, outletId, fallbackPrinterId)

      const station = await tx.station.update({
        where: { id: stationId },
        data: {
          name: dto.name ?? existing.name,
          ageingThresholdMinutes: dto.ageingThresholdMinutes ?? existing.ageingThresholdMinutes,
          primaryPrinterId,
          fallbackPrinterId,
        },
      })
      return toStationView(station)
    })
  }
}
