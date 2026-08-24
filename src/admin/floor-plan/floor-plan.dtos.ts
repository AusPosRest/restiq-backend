import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator'
import type { PrinterRenderMode, TableShape } from '../../generated/prisma/client'

const TABLE_SHAPES = ['circle', 'square', 'rectangle'] as const
const PRINTER_RENDER_MODES = ['text', 'bitmap'] as const

export class CreateFloorDto {
  @IsString() @MinLength(1)
  name!: string

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number
}

export class UpdateFloorDto {
  @IsOptional() @IsString() @MinLength(1)
  name?: string

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number
}

export class CreateTableDto {
  @IsUUID()
  floorId!: string

  @IsString() @MinLength(1)
  label!: string

  @IsInt() @Min(0)
  x!: number

  @IsInt() @Min(0)
  y!: number

  @IsInt() @Min(1)
  width!: number

  @IsInt() @Min(1)
  height!: number

  @IsEnum(TABLE_SHAPES)
  shape!: TableShape

  @IsInt() @Min(1)
  seatCapacity!: number
}

export class UpdateTableDto {
  @IsOptional() @IsString() @MinLength(1)
  label?: string

  @IsOptional() @IsInt() @Min(0)
  x?: number

  @IsOptional() @IsInt() @Min(0)
  y?: number

  @IsOptional() @IsInt() @Min(1)
  width?: number

  @IsOptional() @IsInt() @Min(1)
  height?: number

  @IsOptional() @IsEnum(TABLE_SHAPES)
  shape?: TableShape

  @IsOptional() @IsInt() @Min(1)
  seatCapacity?: number
}

export class CreatePrinterDto {
  @IsString() @MinLength(1)
  name!: string

  @IsEnum(PRINTER_RENDER_MODES)
  renderMode!: PrinterRenderMode
}

// tenant-admin/CAP-6: a printer's own render-mode is the only field it owns
// that this story mutates - fallback routing is a Station field
// (fallbackPrinterId, already PATCH-able via UpdateStationDto) and is not
// duplicated here.
export class UpdatePrinterDto {
  @IsEnum(PRINTER_RENDER_MODES)
  renderMode!: PrinterRenderMode
}

// noPrinterAcknowledged is a one-time confirmation carried on the request,
// never persisted (SPEC CAP-5: every station needs a printer or an explicit
// "no printer" acknowledgement - the acknowledgement gate fires whenever a
// request would leave the station with no primaryPrinterId).
export class CreateStationDto {
  @IsString() @MinLength(1)
  name!: string

  @IsInt() @Min(1)
  ageingThresholdMinutes!: number

  @IsOptional() @IsUUID()
  primaryPrinterId?: string | null

  @IsOptional() @IsUUID()
  fallbackPrinterId?: string | null

  @IsOptional() @IsBoolean()
  noPrinterAcknowledged?: boolean
}

export class UpdateStationDto {
  @IsOptional() @IsString() @MinLength(1)
  name?: string

  @IsOptional() @IsInt() @Min(1)
  ageingThresholdMinutes?: number

  // Omitted = leave unchanged. Present with a uuid = set. Present as null =
  // clear (requires noPrinterAcknowledged if this would leave no printer).
  @IsOptional() @IsUUID()
  primaryPrinterId?: string | null

  @IsOptional() @IsUUID()
  fallbackPrinterId?: string | null

  @IsOptional() @IsBoolean()
  noPrinterAcknowledged?: boolean
}

export interface TableView {
  id: string
  floorId: string
  label: string
  x: number
  y: number
  width: number
  height: number
  shape: TableShape
  seatCapacity: number
}

export interface FloorView {
  id: string
  outletId: string
  name: string
  sortOrder: number
  tables: TableView[]
}

export interface PrinterView {
  id: string
  outletId: string
  name: string
  renderMode: PrinterRenderMode
}

export interface StationView {
  id: string
  outletId: string
  name: string
  ageingThresholdMinutes: number
  primaryPrinterId: string | null
  fallbackPrinterId: string | null
}

export interface FloorPlanView {
  floors: FloorView[]
  stations: StationView[]
  printers: PrinterView[]
}
