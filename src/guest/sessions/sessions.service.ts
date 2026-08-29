// qr-self-order/CAP-1 (AD-17, AD-5, issue #68): the guest realm's table
// session lifecycle - start (first guest, name+phone), join (later guests,
// 4-digit PIN), the authenticated session view, and the staff-side close pos
// calls into (see close-session below, exported through the guest barrel).
import { ConflictException, ForbiddenException, GoneException, HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import type { DiningTable, Guest, Outlet, Prisma, TableSession } from '../../generated/prisma/client'
import { GuestPrincipal, RegionRegistryService, signGuestToken } from '../../platform'
import { isUniqueViolation, setGuestEntryContext, setTenantContext } from '../tenant-context'
import { clearJoinAttempts, isJoinLockedOut, recordFailedJoinAttempt } from './join-lockout'
import { GuestSummary, JoinSessionDto, OutletAvailability, SessionJoinResult, SessionStartResult, StartSessionDto, TableSessionView } from './sessions.dtos'

type Tx = Prisma.TransactionClient

// Idle-TTL backstop (SPEC Assumptions ~4h) - a prototype safety net, not a
// product-designed timeout.
const SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000

const CAPABILITY_KEY = 'qr_ordering'
const UNAVAILABLE_MESSAGE = 'QR ordering is not available for this table right now - please ask a staff member for help'

/**
 * Resolves the tenant that owns this outlet+table pair BEFORE app.tenant_id
 * is known (see tenant-context.ts's setGuestEntryContext), and verifies the
 * table really belongs to the outlet. Never throws a tenant-revealing error -
 * an unknown/mismatched pair is reported as "no such table" the same as a
 * genuinely absent one.
 */
async function resolveOutletAndTable(tx: Tx, outletId: string, tableId: string): Promise<{ outlet: Outlet; table: DiningTable }> {
  await setGuestEntryContext(tx)
  const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
  if (!outlet || outlet.deletedAt) {
    throw new NotFoundException({ code: 'not_found', message: 'No such outlet or table' })
  }
  const table = await tx.diningTable.findUnique({ where: { id: tableId }, include: { floor: true } })
  if (!table || table.tenantId !== outlet.tenantId || table.floor.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such outlet or table' })
  }
  return { outlet, table }
}

/**
 * CAP-1 constraint: an outlet with `qr_ordering` disabled (or no capability
 * row at all - absent means disabled) must be refused server-side, not just
 * by the availability-check endpoint. Called from every entry point
 * (availability check, start, join) so there is exactly one gate, never a
 * client-trusted shortcut.
 */
async function assertQrOrderingEnabled(tx: Tx, outletId: string): Promise<void> {
  const capability = await tx.outletCapability.findUnique({ where: { outletId_key: { outletId, key: CAPABILITY_KEY } } })
  if (!capability?.enabled) {
    throw new ForbiddenException({ code: 'qr_ordering_disabled', message: UNAVAILABLE_MESSAGE })
  }
}

function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

function toGuestSummary(guest: Guest): GuestSummary {
  return { id: guest.id, name: guest.name, joinedAt: guest.joinedAt.toISOString() }
}

function toSessionView(session: TableSession, table: Pick<DiningTable, 'id' | 'label'>, guests: Guest[]): TableSessionView {
  return {
    sessionId: session.id,
    status: session.status,
    table: { id: table.id, label: table.label },
    outletId: session.outletId,
    guests: guests.map(toGuestSummary),
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
  }
}

/** True once a session has moved past "open" (staff-closed, settled, or idle-expired). */
function isSessionInactive(session: TableSession): boolean {
  return session.status !== 'open' || session.expiresAt.getTime() <= Date.now()
}

@Injectable()
export class GuestSessionsService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async checkAvailability(outletId: string): Promise<OutletAvailability> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setGuestEntryContext(tx)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.deletedAt) {
        return { available: false, reason: 'not_found' }
      }
      await setTenantContext(tx, outlet.tenantId)
      const capability = await tx.outletCapability.findUnique({ where: { outletId_key: { outletId, key: CAPABILITY_KEY } } })
      if (!capability?.enabled) {
        return { available: false, reason: 'qr_ordering_disabled' }
      }
      return { available: true }
    })
  }

  async startSession(dto: StartSessionDto): Promise<SessionStartResult> {
    const plane = this.plane()
    try {
      return await plane.$transaction(async (tx) => {
        const { outlet, table } = await resolveOutletAndTable(tx, dto.outletId, dto.tableId)
        await setTenantContext(tx, outlet.tenantId)
        await assertQrOrderingEnabled(tx, dto.outletId)

        const existing = await tx.tableSession.findFirst({ where: { tenantId: outlet.tenantId, tableId: dto.tableId, status: 'open' } })
        if (existing) {
          throw new ConflictException({ code: 'session_already_open', message: 'This table already has an open session - join it with its PIN instead' })
        }

        const pin = generatePin()
        const session = await tx.tableSession.create({
          data: {
            tenantId: outlet.tenantId,
            outletId: dto.outletId,
            tableId: dto.tableId,
            sessionPin: pin,
            startedByGuestName: dto.name,
            startedByGuestPhone: dto.phone,
            expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS),
          },
        })
        const guest = await tx.guest.create({
          data: { tenantId: outlet.tenantId, sessionId: session.id, name: dto.name, phone: dto.phone },
        })

        const principal: GuestPrincipal = {
          id: guest.id,
          sessionId: session.id,
          tenantId: outlet.tenantId,
          outletId: dto.outletId,
          tableId: dto.tableId,
          name: guest.name,
        }
        return { token: signGuestToken(principal), pin, session: toSessionView(session, table, [guest]) }
      })
    } catch (error) {
      // Backstop for table_sessions_one_open_per_table: the check-then-create
      // above has a race window under concurrent starts for the same table
      // (same convention as pos/orders/orders.service.ts's openOrClaimTable).
      // Unlike that endpoint, a raced second start is a genuine conflict here
      // (SPEC: "second start on same table 409s"), never silently resolved.
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'session_already_open', message: 'This table already has an open session - join it with its PIN instead' })
      }
      throw error
    }
  }

  async joinSession(dto: JoinSessionDto): Promise<SessionJoinResult> {
    if (isJoinLockedOut(dto.outletId, dto.tableId)) {
      throw new HttpException({ code: 'locked_out', message: 'Too many incorrect attempts - try again shortly' }, 429)
    }

    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      const { outlet, table } = await resolveOutletAndTable(tx, dto.outletId, dto.tableId)
      await setTenantContext(tx, outlet.tenantId)
      await assertQrOrderingEnabled(tx, dto.outletId)

      const session = await tx.tableSession.findFirst({ where: { tenantId: outlet.tenantId, tableId: dto.tableId, status: 'open' } })
      if (!session || isSessionInactive(session)) {
        throw new NotFoundException({ code: 'no_open_session', message: 'This table has no open session to join - start one instead' })
      }

      if (session.sessionPin !== dto.pin) {
        recordFailedJoinAttempt(dto.outletId, dto.tableId)
        throw new ForbiddenException({ code: 'invalid_pin', message: 'Incorrect PIN' })
      }
      clearJoinAttempts(dto.outletId, dto.tableId)

      const guest = await tx.guest.create({ data: { tenantId: outlet.tenantId, sessionId: session.id, name: dto.name } })
      const guests = await tx.guest.findMany({ where: { sessionId: session.id }, orderBy: { joinedAt: 'asc' } })

      const principal: GuestPrincipal = {
        id: guest.id,
        sessionId: session.id,
        tenantId: outlet.tenantId,
        outletId: dto.outletId,
        tableId: dto.tableId,
        name: guest.name,
      }
      return { token: signGuestToken(principal), session: toSessionView(session, table, guests) }
    })
  }

  async getCurrentSession(guest: GuestPrincipal): Promise<TableSessionView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await tx.tableSession.findUnique({ where: { id: guest.sessionId } })
      if (!session) {
        throw new NotFoundException({ code: 'not_found', message: 'No such session' })
      }
      if (isSessionInactive(session)) {
        throw new GoneException({ code: 'session_closed', message: 'This table session has ended' })
      }
      const table = await tx.diningTable.findUnique({ where: { id: session.tableId } })
      if (!table) {
        throw new NotFoundException({ code: 'not_found', message: 'No such table' })
      }
      const guests = await tx.guest.findMany({ where: { sessionId: session.id }, orderBy: { joinedAt: 'asc' } })
      return toSessionView(session, table, guests)
    })
  }

  /**
   * Staff-side close (pos realm) per lifecycle - called from
   * pos/tables/tables.controller.ts through this service's barrel export
   * (AD-2: cross-module reach only via the owning module's public surface).
   * Idempotent-ish: closing an already-closed/settled session is a 404, not a
   * silent no-op, so staff get a clear signal there was nothing to close.
   */
  async closeSessionForStaff(tenantId: string, outletId: string, tableId: string): Promise<void> {
    const plane = this.plane()
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const table = await tx.diningTable.findUnique({ where: { id: tableId }, include: { floor: true } })
      if (!table || table.tenantId !== tenantId || table.floor.outletId !== outletId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such table for this outlet' })
      }
      const session = await tx.tableSession.findFirst({ where: { tenantId, tableId, status: 'open' } })
      if (!session) {
        throw new NotFoundException({ code: 'no_open_session', message: 'This table has no open session to close' })
      }
      await tx.tableSession.update({ where: { id: session.id }, data: { status: 'closed', closedAt: new Date() } })
    })
  }
}
