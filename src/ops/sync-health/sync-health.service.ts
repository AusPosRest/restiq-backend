// CAP-6 fleet sync health monitor: a read-side projection over the devices
// table's latest-heartbeat snapshot (AD-1 - payload-free telemetry may
// aggregate globally; there is no payload field to begin with, NFR-15).
// Every silent device found is pushed through the alert abstraction so a
// device silent 48h raises an alert with zero customer involvement (SPEC).
import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { RegionRegistryService } from '../../platform'
import { ALERT_CHANNEL, AlertChannel } from './alert-channel'
import { classifySeverity, compareSeverity, Severity } from './severity'

const SEVERITIES: readonly Severity[] = ['healthy', 'lagging', 'silent']

export interface SyncHealthRow {
  deviceId: string
  tenantId: string
  tenantName: string
  outletId: string | null
  outletName: string | null
  deviceLabel: string
  deviceType: string
  lastContactAt: string | null
  lagSeconds: number
  outboxDepth: number | null
  appVersion: string | null
  clockSkewSeconds: number | null
  recentRejectionCount: number | null
  severity: Severity
}

export interface SyncHealthResult {
  devices: SyncHealthRow[]
  summary: Record<Severity, number>
  generatedAt: string
}

function badRequest(message: string): never {
  throw new BadRequestException({ code: 'validation_failed', message })
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

@Injectable()
export class SyncHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncHealthService.name)
  private readonly lastAlertedAt = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private sweeping = false

  constructor(
    private readonly registry: RegionRegistryService,
    @Inject(ALERT_CHANNEL) private readonly alerts: AlertChannel,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error('Silent-device sweep failed', error instanceof Error ? error.message : error)
      })
    }, 60_000)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.list({})
    } finally {
      this.sweeping = false
    }
  }

  async list(query: Record<string, string | undefined>): Promise<SyncHealthResult> {
    const tenantId = query.tenantId
    if (tenantId !== undefined && !/^[0-9a-f-]{36}$/i.test(tenantId)) badRequest('tenantId is not a valid id')
    const severity = query.severity
    if (severity !== undefined && !SEVERITIES.includes(severity as Severity)) {
      badRequest(`severity must be one of: ${SEVERITIES.join(', ')}`)
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const devices = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      return tx.device.findMany({
        where: { status: 'active', ...(tenantId && { tenantId }) },
        include: { tenant: { select: { name: true } }, outlet: { select: { name: true } } },
      })
    })

    if (!tenantId) {
      const activeIds = new Set(devices.map((device) => device.id))
      for (const id of this.lastAlertedAt.keys()) {
        if (!activeIds.has(id)) this.lastAlertedAt.delete(id)
      }
    }
    const now = Date.now()
    const summary: Record<Severity, number> = { healthy: 0, lagging: 0, silent: 0 }
    const rows: SyncHealthRow[] = []

    for (const device of devices) {
      // A device that has never sent a heartbeat is measured from enrolment -
      // silence starts at the moment it should have first checked in.
      const effectiveLastContact = device.lastContactAt ?? device.enrolledAt
      const lagSeconds = Math.max(0, Math.floor((now - effectiveLastContact.getTime()) / 1000))
      const rowSeverity = classifySeverity(lagSeconds)
      summary[rowSeverity] += 1

      const lastAlerted = this.lastAlertedAt.get(device.id)
      if (rowSeverity !== 'silent') this.lastAlertedAt.delete(device.id)
      if (rowSeverity === 'silent' && (lastAlerted === undefined || effectiveLastContact.getTime() > lastAlerted)) {
        // Reserve before awaiting delivery so simultaneous page reads and sweeps
        // cannot both send the same alert. A newer heartbeat starts a new period.
        this.lastAlertedAt.set(device.id, now)
        try {
          await this.alerts.notifySilentDevice({
            deviceId: device.id,
            tenantId: device.tenantId,
            outletId: device.outletId,
            lastContactAt: device.lastContactAt ? device.lastContactAt.toISOString() : null,
            lagSeconds,
          })
        } catch (error) {
          this.lastAlertedAt.delete(device.id)
          throw error
        }
      }

      rows.push({
        deviceId: device.id,
        tenantId: device.tenantId,
        tenantName: device.tenant.name,
        outletId: device.outletId,
        outletName: device.outlet?.name ?? null,
        deviceLabel: device.label,
        deviceType: device.type,
        lastContactAt: device.lastContactAt ? device.lastContactAt.toISOString() : null,
        lagSeconds,
        outboxDepth: device.outboxDepth,
        appVersion: device.appVersion,
        clockSkewSeconds: device.clockSkewSeconds,
        recentRejectionCount: device.recentRejectionCount,
        severity: rowSeverity,
      })
    }

    // Severity-first, most-stale-first within a tier (EXPERIENCE.md O8).
    rows.sort((a, b) => compareSeverity(a.severity, b.severity) || b.lagSeconds - a.lagSeconds)
    const filteredRows = severity ? rows.filter((row) => row.severity === severity) : rows

    // summary always reflects the unfiltered (tenant-scoped) fleet so the KPI
    // tiles stay accurate while the table itself is filtered.
    return { devices: filteredRows, summary, generatedAt: new Date(now).toISOString() }
  }
}
