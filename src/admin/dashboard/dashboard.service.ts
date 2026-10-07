// CAP-8 owner dashboard. RESTIQ's POS Core Loop (the surface that would
// generate Order/Bill/Payment rows) hasn't been built yet - there is no
// transactional source anywhere in this codebase for live sales, margin,
// labour cost, or waste. Rather than fabricate numbers or omit the fields,
// every financial figure is returned as an explicit, honest zero with
// hasData:false and a message telling the owner why - the SPEC's "never a
// silently outdated number presented as current" success criterion is
// stronger here: no number is presented as current at all.
//
// Counts that ARE real today come from each capability's own table:
// outlets (CAP-10), staff_users (CAP-7), menu_items (CAP-4), devices
// (CAP-6). staff_users and menu_items are tenant-scoped, not outlet-scoped -
// staff_users has no outletId at all (see wiki/features/tenant-admin.md's
// CAP-7 section: outlet-scoped staff access was never modelled), and
// menu_items belong to the tenant's shared catalog (only per-item
// *availability* is overridable per outlet, not the item's existence). So
// staffCount and menuItemCount are reported once, in the tenant rollup, not
// split per outlet - splitting them would fabricate a per-outlet number the
// data model doesn't back. deviceCount is genuinely outlet-scoped
// (devices.outlet_id) and is reported both per outlet and summed in the
// rollup.
import { Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { localDateKey } from '../../pos'
import { setTenantContext } from '../menu/tenant-context'

export interface DashboardMetric {
  amountMinor: number
  currency: string
  hasData: boolean
  message: string
}

export interface OutletDashboardView {
  outletId: string
  outletName: string
  deviceCount: number
  sales: DashboardMetric
  margin: DashboardMetric
  labourCost: DashboardMetric
  waste: DashboardMetric
}

export interface DashboardTenantRollup {
  outletCount: number
  staffCount: number
  menuItemCount: number
  deviceCount: number
  status: string
  goLiveAt: string | null
}

export interface DashboardView {
  asOf: string
  tenant: DashboardTenantRollup
  outlets: OutletDashboardView[]
}

const NO_DATA_MESSAGE = 'No sales yet today'
const GO_LIVE_ACTION = 'tenant.went_live'

function currencyForCountry(country: string): string {
  return country === 'IN' ? 'INR' : 'AUD'
}

function noDataMetric(currency: string): DashboardMetric {
  return { amountMinor: 0, currency, hasData: false, message: NO_DATA_MESSAGE }
}

@Injectable()
export class DashboardService {
  constructor(private readonly registry: RegionRegistryService) {}

  async get(owner: AdminPrincipal): Promise<DashboardView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)

      const tenant = await tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { country: true, status: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      const currency = currencyForCountry(tenant.country)

      const [outlets, staffCount, menuItemCount, devicesByOutlet, wentLive] = await Promise.all([
        tx.outlet.findMany({ where: { tenantId: owner.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
        tx.staffUser.count({ where: { tenantId: owner.tenantId } }),
        tx.menuItem.count({ where: { tenantId: owner.tenantId, available: true, archivedAt: null } }),
        tx.device.groupBy({
          by: ['outletId'],
          where: { tenantId: owner.tenantId, status: 'active', outletId: { not: null } },
          _count: { _all: true },
        }),
        // At most one such row exists per tenant (goLive() is idempotent and
        // only ever audits the provisioning -> active transition once) - this
        // just tolerates the theoretical case of more than one without
        // erroring, by taking the earliest.
        tx.auditEvent.findFirst({ where: { tenantId: owner.tenantId, action: GO_LIVE_ACTION }, orderBy: { occurredAt: 'asc' } }),
      ])

      // issue #189: today's takings per outlet - tenders on finalised bills,
      // "today" being each outlet's own calendar day. 48h back covers any
      // timezone's today without scanning the whole table (same window as
      // bills.service's listPaymentsToday).
      const now = new Date()
      const recentTenders = await tx.tender.findMany({
        where: { tenantId: owner.tenantId, createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) }, bill: { status: 'finalized' } },
        select: { amountMinor: true, createdAt: true, bill: { select: { outletId: true } } },
      })
      const timezoneByOutlet = new Map(outlets.map((outlet) => [outlet.id, outlet.timezone]))
      const salesByOutlet = new Map<string, number>()
      for (const tender of recentTenders) {
        const timezone = timezoneByOutlet.get(tender.bill.outletId)
        if (!timezone || localDateKey(tender.createdAt, timezone) !== localDateKey(now, timezone)) continue
        salesByOutlet.set(tender.bill.outletId, (salesByOutlet.get(tender.bill.outletId) ?? 0) + Number(tender.amountMinor))
      }

      const deviceCountByOutlet = new Map(devicesByOutlet.map((row) => [row.outletId as string, row._count._all]))
      const totalDeviceCount = devicesByOutlet.reduce((sum, row) => sum + row._count._all, 0)

      const outletViews: OutletDashboardView[] = outlets.map((outlet) => ({
        outletId: outlet.id,
        outletName: outlet.name,
        deviceCount: deviceCountByOutlet.get(outlet.id) ?? 0,
        sales: salesByOutlet.has(outlet.id)
          ? { amountMinor: salesByOutlet.get(outlet.id) ?? 0, currency, hasData: true, message: 'Today so far' }
          : noDataMetric(currency),
        margin: noDataMetric(currency),
        labourCost: noDataMetric(currency),
        waste: noDataMetric(currency),
      }))

      return {
        asOf: new Date().toISOString(),
        tenant: {
          outletCount: outlets.length,
          staffCount,
          menuItemCount,
          deviceCount: totalDeviceCount,
          status: tenant.status,
          goLiveAt: wentLive ? wentLive.occurredAt.toISOString() : null,
        },
        outlets: outletViews,
      }
    })
  }
}
