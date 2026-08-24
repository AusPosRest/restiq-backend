// Alert delivery channel abstraction (architecture spine "Deferred": email/
// Slack/pager is a later decision). CAP-6 emits through this interface only;
// LogAlertChannel is the no-op-but-visible implementation for now.
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
