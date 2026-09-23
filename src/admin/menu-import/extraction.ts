// CAP-3: turns an uploaded file into a draft list of menu items with a
// confidence score per field. CSV and XLSX are actually parsed - real
// structure in, real (high-confidence) values out. No vision/OCR service is
// wired up yet, so image and PDF uploads are refused with a clear 422 instead
// of the fixed sample draft they used to get - owners committed that sample as
// if it were their own menu (restiq-web#246).
import { UnprocessableEntityException } from '@nestjs/common'
import ExcelJS from 'exceljs'
import { uuidv7 } from '../../platform'

export type MenuImportSourceType = 'csv' | 'xlsx' | 'image' | 'pdf'

export interface DraftFieldConfidence {
  name: number
  shortName: number
  category: number
  price: number
  overall: number
}

export interface DraftItem {
  id: string
  name: string
  shortName: string
  category: string
  priceMinor: number
  currency: string
  confidence: DraftFieldConfidence
}

type Field = 'name' | 'shortName' | 'category' | 'price'

const HEADER_ALIASES: Record<Field, string[]> = {
  name: ['name', 'item', 'itemname', 'menuitem', 'dish', 'dishname'],
  shortName: ['shortname', 'short', 'kot', 'kotname', 'kitchenname'],
  category: ['category', 'section', 'group', 'menucategory'],
  price: ['price', 'rate', 'amount', 'cost', 'priceminor', 'mrp'],
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchColumns(headerRow: string[]): Partial<Record<Field, number>> {
  const normalized = headerRow.map(normalizeHeader)
  const columns: Partial<Record<Field, number>> = {}
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    const index = normalized.findIndex((h) => HEADER_ALIASES[field].includes(h))
    if (index !== -1) columns[field] = index
  }
  return columns
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function deriveShortName(name: string): string {
  return name.length <= 16 ? name : `${name.slice(0, 15)}…`
}

function parsePriceMinor(raw: string | undefined): { priceMinor: number; confidence: number } {
  const trimmed = raw?.trim()
  if (!trimmed) return { priceMinor: 0, confidence: 0.3 }
  const major = Number.parseFloat(trimmed.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(major) || major < 0) return { priceMinor: 0, confidence: 0.3 }
  return { priceMinor: Math.round(major * 100), confidence: 1 }
}

function buildDraftItem(row: string[], columns: Partial<Record<Field, number>>, currency: string): DraftItem | null {
  const name = columns.name !== undefined ? row[columns.name]?.trim() : undefined
  if (!name) return null // a nameless row cannot become a menu item

  const rawCategory = columns.category !== undefined ? row[columns.category]?.trim() : undefined
  const category = rawCategory || 'Uncategorised'
  const categoryConfidence = rawCategory ? 1 : 0.3

  const rawShortName = columns.shortName !== undefined ? row[columns.shortName]?.trim() : undefined
  const shortName = rawShortName || deriveShortName(name)
  const shortNameConfidence = rawShortName ? 1 : 0.5

  const { priceMinor, confidence: priceConfidence } = parsePriceMinor(columns.price !== undefined ? row[columns.price] : undefined)

  return {
    id: uuidv7(),
    name,
    shortName,
    category,
    priceMinor,
    currency,
    confidence: {
      name: 1,
      shortName: shortNameConfidence,
      category: categoryConfidence,
      price: priceConfidence,
      overall: round2((1 + shortNameConfidence + categoryConfidence + priceConfidence) / 4),
    },
  }
}

function rowsToDraftItems(rows: string[][], currency: string): DraftItem[] {
  const [header, ...body] = rows
  if (!header) return []
  const columns = matchColumns(header)
  const items: DraftItem[] = []
  for (const row of body) {
    const item = buildDraftItem(row, columns, currency)
    if (item) items.push(item)
  }
  return items
}

/** Minimal RFC4180-style CSV parser: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0))
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('')
    }
    const primitive = 'result' in obj ? obj.result : obj.text
    return typeof primitive === 'string' || typeof primitive === 'number' ? String(primitive) : ''
  }
  return String(value)
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []
  const rows: string[][] = []
  sheet.eachRow((row) => {
    const values = row.values as ExcelJS.CellValue[]
    // ExcelJS's row.values is 1-indexed (index 0 is always empty).
    rows.push(values.slice(1).map(cellToString))
  })
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0))
}

export async function extractDraftItems(sourceType: MenuImportSourceType, buffer: Buffer, currency: string): Promise<DraftItem[]> {
  if (sourceType === 'csv') return rowsToDraftItems(parseCsv(buffer.toString('utf8')), currency)
  if (sourceType === 'xlsx') return rowsToDraftItems(await parseXlsx(buffer), currency)
  // ponytail: photo/PDF reading needs a vision model (and its API key); it plugs in here, same DraftItem[] out.
  throw new UnprocessableEntityException({
    code: 'extraction_unavailable',
    message: "Reading menus from photos and PDFs isn't available yet. Download the sample spreadsheet, fill it in and upload it as CSV or XLSX.",
  })
}
