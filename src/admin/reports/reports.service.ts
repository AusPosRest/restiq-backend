// CAP-9 reports catalogue. RESTIQ's POS Core Loop (the surface that would
// generate Order/Bill/Payment/Document/Z-report rows) hasn't been built yet -
// there is no transactional source anywhere in this codebase for Sales,
// Financial (GST/BAS), Menu Engineering (by volume), Operations, Inventory,
// or Labour-cost reports. Rather than fabricate report content or invent a
// shadow transactional model to populate this screen, every such entry in
// the catalogue is returned honestly with hasData:false, an explanatory
// message, and no export formats - same "never present a fabricated number
// as current" posture as CAP-8's dashboard (dashboard.service.ts).
//
// Two report types CAN be built from real data that already exists: a menu
// catalogue export (CAP-4's menu_categories/menu_items/item_prices) and a
// staff roster export (CAP-7's staff_users/roles). Both are real,
// tenant-scoped CSV exports backed by the live tables, not samples.
//
// The accounting export destination list (Tally/Xero/MYOB/Zoho/QuickBooks)
// is static and every destination is honestly "not_connected" - no OAuth/API
// integration to any of these exists anywhere in the codebase yet.
import { BadRequestException, Injectable } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { resolveCurrentPrice } from '../menu/pricing'
import { pinStatus } from '../staff/staff.service'
import { toCsv } from './csv'
import { ExportDestinationView, ReportCatalogueEntry } from './reports.dtos'

const PENDING_ON_POS_MESSAGE = 'Available once POS Core Loop is live'

// One entry per named report type from the SPEC/PRD (CAP-9). The two with
// hasData:true are backed by real tenant tables today; the rest depend on
// transactional order/bill data that doesn't exist yet.
const REPORT_CATALOGUE: ReportCatalogueEntry[] = [
  { key: 'sales-summary', name: 'Sales Summary', category: 'sales', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'gst-bas', name: 'GST/BAS Report', category: 'financial', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'menu-catalogue', name: 'Menu Catalogue', category: 'menu', hasData: true, message: 'Current categories, items, and prices from your live menu', exportFormats: ['csv'] },
  { key: 'menu-engineering', name: 'Menu Engineering', category: 'menu', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'operations-summary', name: 'Operations Summary', category: 'operations', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'inventory-summary', name: 'Inventory Summary', category: 'inventory', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'staff-roster', name: 'Staff Roster', category: 'labour', hasData: true, message: 'Current staff and their assigned roles', exportFormats: ['csv'] },
  { key: 'labour-cost', name: 'Labour Cost', category: 'labour', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
]

const EXPORT_DESTINATIONS: ExportDestinationView[] = [
  { key: 'tally', name: 'Tally', status: 'not_connected' },
  { key: 'xero', name: 'Xero', status: 'not_connected' },
  { key: 'myob', name: 'MYOB', status: 'not_connected' },
  { key: 'zoho', name: 'Zoho Books', status: 'not_connected' },
  { key: 'quickbooks', name: 'QuickBooks', status: 'not_connected' },
]

function formatMinor(minor: bigint): string {
  return (Number(minor) / 100).toFixed(2)
}

// Both exports currently only produce CSV (see each catalogue entry's
// exportFormats) - a bad/missing format is a 400, not a silent fallback.
function assertCsvFormat(format: string): void {
  if (format !== 'csv') {
    throw new BadRequestException({ code: 'validation_failed', message: 'format must be csv' })
  }
}

@Injectable()
export class ReportsService {
  constructor(private readonly registry: RegionRegistryService) {}

  // Tenant-agnostic report definitions - no DB read, same list for every
  // caller (the guard already requires a valid owner session to reach it).
  catalogue(): ReportCatalogueEntry[] {
    return REPORT_CATALOGUE
  }

  exportDestinations(): ExportDestinationView[] {
    return EXPORT_DESTINATIONS
  }

  // Real CSV of the live menu: category, item, short name, variant (if any),
  // current price, currency, and 86 status. "Current price" uses the same
  // resolution rule as CAP-4's live read (menu/pricing.ts), taken for the
  // dine-in channel with no outlet override, since a report needs one
  // representative price per row rather than a per-channel/per-outlet
  // matrix. An item/variant with no priced row yet exports an empty price
  // rather than a fabricated one.
  async exportMenuCatalogueCsv(owner: AdminPrincipal, format: string): Promise<string> {
    assertCsvFormat(format)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const items = await tx.menuItem.findMany({
        where: { tenantId: owner.tenantId },
        include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      })

      const rows: string[][] = []
      for (const item of items) {
        const lines: { id: string | null; name: string | null }[] = item.variants.length > 0 ? item.variants.map((v) => ({ id: v.id, name: v.name })) : [{ id: null, name: null }]
        for (const line of lines) {
          const price = await resolveCurrentPrice(tx, { tenantId: owner.tenantId, itemId: item.id, variantId: line.id, channel: 'dine_in', outletId: null })
          rows.push([item.category.name, item.name, item.shortName, line.name ?? '', price ? formatMinor(price.priceMinor) : '', price ? price.currency : '', item.available ? 'yes' : 'no'])
        }
      }

      return toCsv(['category', 'item', 'short_name', 'variant', 'price', 'currency', 'available'], rows)
    })
  }

  // Real CSV of current staff: name, email, assigned role, PIN status.
  async exportStaffRosterCsv(owner: AdminPrincipal, format: string): Promise<string> {
    assertCsvFormat(format)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const staff = await tx.staffUser.findMany({
        where: { tenantId: owner.tenantId },
        include: { role: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })
      const rows = staff.map((s) => [s.name, s.email ?? '', s.role.name, pinStatus(s)])
      return toCsv(['name', 'email', 'role', 'pin_status'], rows)
    })
  }
}
