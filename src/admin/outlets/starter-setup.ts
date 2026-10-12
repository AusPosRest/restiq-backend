// Starter setup per outlet type (D2): what a new outlet gets so it can sell
// without hand-building stations and tables. Everything here is a normal row the
// owner can rename, remove or add to through the usual floor-plan and capability
// endpoints - nothing is locked. Applying it twice only fills in what is missing.
import type { Prisma } from '../../generated/prisma/client'

export type StarterOutletType = 'dine_in' | 'qsr' | 'cloud_kitchen' | 'food_court'

interface StarterSetup {
  stations: string[]
  /** One floor with this many tables; omitted for types that have no table map. */
  floor?: { name: string; tables: number }
  capabilities: Record<string, boolean>
}

export const STARTER_SETUPS: Record<StarterOutletType, StarterSetup> = {
  dine_in: {
    stations: ['Hot Kitchen', 'Cold / Salad', 'Bar', 'Dessert', 'Expo (pass)'],
    floor: { name: 'Main hall', tables: 8 },
    capabilities: { qr_ordering: true, token_queue: false, kiosk: false },
  },
  qsr: {
    stations: ['Grill', 'Fry', 'Beverages', 'Assembly / Expo'],
    capabilities: { qr_ordering: false, token_queue: true, kiosk: false },
  },
  cloud_kitchen: {
    stations: ['Prep line', 'Packing / Dispatch'],
    capabilities: { qr_ordering: false, token_queue: false, kiosk: false },
  },
  food_court: {
    stations: ['Stall prep'],
    capabilities: { qr_ordering: false, token_queue: true, kiosk: true },
  },
}

export interface StarterSetupResult {
  type: StarterOutletType
  stationsCreated: string[]
  tablesCreated: number
  capabilitiesSet: string[]
}

const TABLE_COLUMNS = 4
const TABLE_SIZE = 100
const TABLE_GAP = 40
const AGEING_MINUTES = 15

/**
 * Fills in whatever the type's setup is missing, inside the caller's tenant
 * transaction. Never overwrites: a station that exists (or that the owner
 * removed) is skipped, tables are laid out only when
 * the outlet has no floor yet, and a switch the owner already set keeps its value.
 */
export async function applyStarterSetup(tx: Prisma.TransactionClient, tenantId: string, outletId: string, type: StarterOutletType): Promise<StarterSetupResult> {
  const setup = STARTER_SETUPS[type]
  const result: StarterSetupResult = { type, stationsCreated: [], tablesCreated: 0, capabilitiesSet: [] }

  // A removed station is renamed "<name> (removed xxxxxx)" to free its name; strip that so removing one is not undone by running this again.
  const existingStations = new Set((await tx.station.findMany({ where: { outletId }, select: { name: true } })).map((s) => s.name.replace(/ \(removed [0-9a-f]{6}\)$/, '')))
  for (const name of setup.stations) {
    if (existingStations.has(name)) continue
    // No printer yet: the owner links one from Devices. A station with no printer still shows on its kitchen screen.
    await tx.station.create({ data: { tenantId, outletId, name, ageingThresholdMinutes: AGEING_MINUTES } })
    result.stationsCreated.push(name)
  }

  if (setup.floor && (await tx.floor.count({ where: { outletId } })) === 0) {
    const floor = await tx.floor.create({ data: { tenantId, outletId, name: setup.floor.name, sortOrder: 0 } })
    for (let i = 0; i < setup.floor.tables; i++) {
      await tx.diningTable.create({
        data: {
          tenantId,
          floorId: floor.id,
          label: `T${i + 1}`,
          x: (i % TABLE_COLUMNS) * (TABLE_SIZE + TABLE_GAP),
          y: Math.floor(i / TABLE_COLUMNS) * (TABLE_SIZE + TABLE_GAP),
          width: TABLE_SIZE,
          height: TABLE_SIZE,
          shape: 'square',
          seatCapacity: 4,
        },
      })
    }
    result.tablesCreated = setup.floor.tables
  }

  const existingKeys = new Set((await tx.outletCapability.findMany({ where: { outletId }, select: { key: true } })).map((c) => c.key))
  for (const [key, enabled] of Object.entries(setup.capabilities)) {
    if (existingKeys.has(key)) continue
    await tx.outletCapability.create({ data: { tenantId, outletId, key, enabled } })
    result.capabilitiesSet.push(key)
  }
  return result
}
