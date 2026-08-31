// CAP-2 go-live checklist. All five steps are required in v1 (no
// stated product decision to make any optional); go-live flips the region
// tenant's status from provisioning to active (AD-9: state lives region-side,
// never in the control-plane registry) and audits the transition (AD-6).
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { CHECKLIST_STEPS, ChecklistStep } from './checklist.dtos'

const STEP_COLUMN = {
  outlet_details: 'outletDetailsAt',
  floor_plan: 'floorPlanAt',
  menu_import: 'menuImportAt',
  devices: 'devicesAt',
  staff: 'staffAt',
} as const satisfies Record<ChecklistStep, string>

interface ProgressRow {
  outletDetailsAt: Date | null
  floorPlanAt: Date | null
  menuImportAt: Date | null
  devicesAt: Date | null
  staffAt: Date | null
}

export interface ChecklistStepView {
  step: ChecklistStep
  completed: boolean
  completedAt: string | null
}

export interface ChecklistView {
  steps: ChecklistStepView[]
  canGoLive: boolean
  tenantStatus: string
}

export interface GoLiveResult {
  tenant: { id: string; status: string }
}

function isChecklistStep(value: string): value is ChecklistStep {
  return (CHECKLIST_STEPS as readonly string[]).includes(value)
}

function toSteps(row: ProgressRow): ChecklistStepView[] {
  return CHECKLIST_STEPS.map((step) => {
    const completedAt = row[STEP_COLUMN[step]]
    return { step, completed: completedAt !== null, completedAt: completedAt ? completedAt.toISOString() : null }
  })
}

function missingSteps(row: ProgressRow): ChecklistStep[] {
  return CHECKLIST_STEPS.filter((step) => row[STEP_COLUMN[step]] === null)
}

async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

@Injectable()
export class ChecklistService {
  constructor(private readonly registry: RegionRegistryService) {}

  async getChecklist(tenantId: string): Promise<ChecklistView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

      // Self-healing: accept-invite always creates this row, but a checklist
      // read must never 404 a legitimate owner session over it.
      const progress = await tx.checklistProgress.upsert({ where: { tenantId }, create: { tenantId }, update: {} })

      return { steps: toSteps(progress), canGoLive: missingSteps(progress).length === 0, tenantStatus: tenant.status }
    })
  }

  async updateStep(tenantId: string, step: string, completed: boolean): Promise<ChecklistView> {
    if (!isChecklistStep(step)) {
      throw new BadRequestException({ code: 'validation_failed', message: `step must be one of: ${CHECKLIST_STEPS.join(', ')}` })
    }
    const column = STEP_COLUMN[step]
    const plane = this.registry.planeFor(this.registry.homeRegion())

    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

      const progress = await tx.checklistProgress.upsert({
        where: { tenantId },
        create: { tenantId, [column]: completed ? new Date() : null },
        update: { [column]: completed ? new Date() : null },
      })

      return { steps: toSteps(progress), canGoLive: missingSteps(progress).length === 0, tenantStatus: tenant.status }
    })
  }

  async goLive(owner: AdminPrincipal): Promise<GoLiveResult> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const tenant = await tx.tenant.findUnique({ where: { id: owner.tenantId } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

      const progress = await tx.checklistProgress.upsert({ where: { tenantId: owner.tenantId }, create: { tenantId: owner.tenantId }, update: {} })
      const missing = missingSteps(progress)
      if (missing.length > 0) {
        throw new ConflictException({
          code: 'checklist_incomplete',
          message: `Complete the required steps before going live: ${missing.join(', ')}`,
          missingSteps: missing,
        })
      }

      const updated = tenant.status === 'active' ? tenant : await tx.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } })

      if (tenant.status !== 'active') {
        await tx.auditEvent.create({
          data: {
            tenantId: owner.tenantId,
            actorId: owner.id,
            actorEmail: owner.email,
            action: 'tenant.went_live',
            reason: 'Owner completed the go-live checklist',
            occurredAt: new Date(),
          },
        })
      }

      return { tenant: { id: updated.id, status: updated.status } }
    })
  }
}
