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

// PE-33/CU-7: the day at a glance. One definition of a day's sales, shared
// with Reports > Payments filtered to the same day: bills finalised today
// (outlet's own calendar day), at their bill totals, less the refunds
// (credit notes) issued against those bills. All in minor units.
export interface OutletTodayView {
  billCount: number
  grossMinor: number
  refundedMinor: number
  netMinor: number
  averageBillMinor: number
  openOrderCount: number
  byMethod: { method: string; amountMinor: number }[]
}

export interface OutletDashboardView {
  outletId: string
  outletName: string
  deviceCount: number
  // amountMinor is today's net sales (OutletTodayView.netMinor).
  sales: DashboardMetric
  margin: DashboardMetric
  labourCost: DashboardMetric
  waste: DashboardMetric
  today: OutletTodayView
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

      // issue #189 / PE-33: today's sales per outlet, "today" being each
      // outlet's own calendar day. 48h back covers any timezone's today
      // without scanning the whole table (same window as bills.service's
      // listPaymentsToday).
      const now = new Date()
      const [recentBills, openOrders] = await Promise.all([
        tx.bill.findMany({
          where: { tenantId: owner.tenantId, status: 'finalized', finalizedAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) } },
          select: {
            outletId: true,
            finalizedAt: true,
            subtotalMinor: true,
            taxMinor: true,
            discountMinor: true,
            pricesIncludeTax: true,
            tenders: { select: { method: true, amountMinor: true } },
            creditNotes: { select: { subtotalMinor: true, taxMinor: true } },
          },
        }),
        tx.order.groupBy({ by: ['outletId'], where: { tenantId: owner.tenantId, status: { in: ['open', 'sent'] } }, _count: { _all: true } }),
      ])
      const timezoneByOutlet = new Map(outlets.map((outlet) => [outlet.id, outlet.timezone]))
      const todayByOutlet = new Map<string, { billCount: number; grossMinor: bigint; refundedMinor: bigint; byMethod: Map<string, bigint> }>()
      for (const bill of recentBills) {
        const timezone = timezoneByOutlet.get(bill.outletId)
        if (!timezone || !bill.finalizedAt || localDateKey(bill.finalizedAt, timezone) !== localDateKey(now, timezone)) continue
        const day = todayByOutlet.get(bill.outletId) ?? { billCount: 0, grossMinor: 0n, refundedMinor: 0n, byMethod: new Map<string, bigint>() }
        day.billCount += 1
        // Same pricesIncludeTax-aware totals as reports.service.ts's totalsFor.
        day.grossMinor += bill.pricesIncludeTax ? bill.subtotalMinor - (bill.discountMinor ?? 0n) : bill.subtotalMinor + bill.taxMinor - (bill.discountMinor ?? 0n)
        for (const note of bill.creditNotes) day.refundedMinor += bill.pricesIncludeTax ? note.subtotalMinor : note.subtotalMinor + note.taxMinor
        for (const tender of bill.tenders) day.byMethod.set(tender.method, (day.byMethod.get(tender.method) ?? 0n) + tender.amountMinor)
        todayByOutlet.set(bill.outletId, day)
      }
      const openOrdersByOutlet = new Map(openOrders.map((row) => [row.outletId, row._count._all]))
      const todayFor = (outletId: string): OutletTodayView => {
        const day = todayByOutlet.get(outletId)
        const grossMinor = Number(day?.grossMinor ?? 0n)
        const refundedMinor = Number(day?.refundedMinor ?? 0n)
        const billCount = day?.billCount ?? 0
        return {
          billCount,
          grossMinor,
          refundedMinor,
          netMinor: grossMinor - refundedMinor,
          averageBillMinor: billCount > 0 ? Math.round(grossMinor / billCount) : 0,
          openOrderCount: openOrdersByOutlet.get(outletId) ?? 0,
          byMethod: [...(day?.byMethod ?? new Map<string, bigint>())]
            .map(([method, amountMinor]) => ({ method, amountMinor: Number(amountMinor) }))
            .sort((a, b) => b.amountMinor - a.amountMinor),
        }
      }

      const deviceCountByOutlet = new Map(devicesByOutlet.map((row) => [row.outletId as string, row._count._all]))
      const totalDeviceCount = devicesByOutlet.reduce((sum, row) => sum + row._count._all, 0)

      const outletViews: OutletDashboardView[] = outlets.map((outlet) => {
        const today = todayFor(outlet.id)
        return {
          outletId: outlet.id,
          outletName: outlet.name,
          deviceCount: deviceCountByOutlet.get(outlet.id) ?? 0,
          sales: today.billCount > 0 ? { amountMinor: today.netMinor, currency, hasData: true, message: 'Today so far, after refunds' } : noDataMetric(currency),
          margin: noDataMetric(currency),
          labourCost: noDataMetric(currency),
          waste: noDataMetric(currency),
          today,
        }
      })

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
