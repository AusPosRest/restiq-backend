// Alert delivery channel abstraction (architecture spine "Deferred": email/
// Slack/pager is a later decision). CAP-6 emits through this interface only.
// restiq-backend#175 (audit PROD-09): WebhookAlertChannel reaches a person -
// it posts to ALERT_WEBHOOK_URL (a Slack/Teams-style incoming webhook, or a
// pager's generic webhook) and always logs too. No URL = log only, as before.
import { Injectable } from '@nestjs/common'

export interface SilentDeviceAlert {
  deviceId: string
  tenantId: string
  outletId: string | null
  lastContactAt: string | null
  lagSeconds: number
}

export interface AlertChannel {
  notifySilentDevice(alert: SilentDeviceAlert): Promise<void>
}

export const ALERT_CHANNEL = Symbol('ALERT_CHANNEL')

@Injectable()
export class LogAlertChannel implements AlertChannel {
  notifySilentDevice(alert: SilentDeviceAlert): Promise<void> {
    const hours = Math.floor(alert.lagSeconds / 3600)
    // Metadata only (NFR-15) - device/tenant ids and a timestamp, never a payload.
    console.warn(`[sync-health alert] device ${alert.deviceId} (tenant ${alert.tenantId}) silent for ${hours}h`)
    return Promise.resolve()
  }
}

@Injectable()
export class WebhookAlertChannel implements AlertChannel {
  private readonly log = new LogAlertChannel()

  async notifySilentDevice(alert: SilentDeviceAlert): Promise<void> {
    await this.log.notifySilentDevice(alert)
    const url = process.env.ALERT_WEBHOOK_URL
    if (!url) return
    const hours = Math.floor(alert.lagSeconds / 3600)
    const lastSeen = alert.lastContactAt ?? 'never'
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` is what Slack/Teams incoming webhooks render; `alert` is for anything that parses it.
        // Metadata only (NFR-15): ids and timestamps, never order or payment data.
        body: JSON.stringify({
          text: `RESTIQ: device ${alert.deviceId} (tenant ${alert.tenantId}, outlet ${alert.outletId ?? '-'}) has been silent for ${hours}h - last seen ${lastSeen}. Runbook: wiki/ops/alerts.md`,
          alert: { type: 'silent_device', ...alert },
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) console.error(`[sync-health alert] webhook answered ${res.status}`)
    } catch (error) {
      // A dead webhook must never break the sweep that found the problem.
      console.error('[sync-health alert] webhook delivery failed', error instanceof Error ? error.message : error)
    }
  }
}
