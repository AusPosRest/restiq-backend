// #201: plan list prices per country (Platform Console > Plans). A price change is a commercial
// decision, so it carries a reason and lands in the control-plane audit log, like other ops edits.
import { BadRequestException, Injectable } from '@nestjs/common'
import { ControlPlaneAuditService, OpsPrincipal, RegionRegistryService } from '../../platform'
import type { PlanPrice } from '../../generated/prisma/client'
import { PLAN_COUNTRIES, PLANS, PlanPriceView, UpdatePlanPriceDto } from './plan-prices.dtos'

const CURRENCY = { AU: 'AUD', IN: 'INR' } as const

function toView(row: PlanPrice): PlanPriceView {
  return {
    country: row.country,
    plan: row.plan,
    monthlyPriceMinor: row.monthlyPriceMinor === null ? null : Number(row.monthlyPriceMinor),
    annualDiscountPercent: row.annualDiscountPercent,
    currency: CURRENCY[row.country],
    updatedAt: row.updatedAt.toISOString(),
  }
}

@Injectable()
export class PlanPricesService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  // ponytail: home region plane only, same as the product directory.
  private get plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async list(): Promise<{ prices: PlanPriceView[] }> {
    const rows = await this.plane.planPrice.findMany({ orderBy: [{ country: 'asc' }, { plan: 'asc' }] })
    return { prices: rows.map(toView) }
  }

  async update(operator: OpsPrincipal, country: string, plan: string, dto: UpdatePlanPriceDto): Promise<{ price: PlanPriceView }> {
    const c = PLAN_COUNTRIES.find((value) => value === country)
    const p = PLANS.find((value) => value === plan)
    if (!c || !p) throw new BadRequestException({ code: 'validation_failed', message: 'Unknown country or plan' })
    const data = { monthlyPriceMinor: dto.monthlyPriceMinor === null ? null : BigInt(dto.monthlyPriceMinor), annualDiscountPercent: dto.annualDiscountPercent }
    const row = await this.plane.planPrice.upsert({ where: { country_plan: { country: c, plan: p } }, create: { country: c, plan: p, ...data }, update: data })
    const price = dto.monthlyPriceMinor === null ? 'on quote' : `${CURRENCY[c]} ${(dto.monthlyPriceMinor / 100).toFixed(2)}`
    await this.audit.record({
      actorId: operator.id,
      actorEmail: operator.email,
      action: 'plan_price.updated',
      reason: `${c} ${p}: ${price}/outlet/month, ${dto.annualDiscountPercent}% off annual - ${dto.reason}`,
      occurredAt: new Date(),
    })
    return { price: toView(row) }
  }
}
