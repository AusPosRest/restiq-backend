// Control-plane audit writer (AD-8): operator-identity actions audit here,
// tenant-affecting actions will audit into their region plane, never both.
// Rows are append-only (AD-6) - nothing in this codebase updates or deletes them.
import { Injectable } from '@nestjs/common'
import { PrismaService } from './prisma.service'

export interface ControlPlaneAuditEntry {
  actorId?: string
  actorEmail: string
  action: string
  reason?: string
  occurredAt: Date
}

@Injectable()
export class ControlPlaneAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: ControlPlaneAuditEntry): Promise<void> {
    await this.prisma.client.controlPlaneAuditEvent.create({
      data: {
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail,
        action: entry.action,
        reason: entry.reason ?? null,
        occurredAt: entry.occurredAt,
      },
    })
  }
}
