// qr-self-order/CAP-4 (issue #77, AD-18): "one order pipeline, many writers" -
// placing the table order converts the session's shared cart (guest/cart)
// into a real Order/OrderLine set, fired to the kitchen through the SAME
// transition pos/orders/orders.service.ts's updateStatus uses for a staff
// order (KitchenTicketsService.fireOnSend, same transaction) - never a
// parallel guest-order model or a second fire implementation.
//
// This service builds the Order/OrderLine rows directly against Prisma
// (mirroring pos/orders/order-lines.service.ts's shape) rather than calling
// into pos/orders' OrdersService/OrderLinesService: those classes are
// staff-gated (every method takes a PosPrincipal and enforces assertOwner),
// or reach into the same cart/CartLine that cart.service.ts already
// validates. Reusing them here would either require a fake staff principal
// (exactly what Order.ownerId's schema comment says not to do) or a NestJS
// module cycle (pos/pos.module.ts already imports GuestModule for the
// staff-side session close - see pos/tables/tables.controller.ts - so
// GuestModule importing PosModule back would cycle the DI graph). The one
// piece of pos/orders' machinery genuinely shared here is the kitchen fire
// hook itself (src/kitchen, AD-16), which has no such dependency and is
// injected the same way pos/orders does.
import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common'
import { resolveCurrentPrice } from '../../admin'
import type { Prisma, PriceChannel, TableSession } from '../../generated/prisma/client'
import { KitchenTicketsService } from '../../kitchen'
import { GuestPrincipal, RegionRegistryService } from '../../platform'
import { isSessionInactive } from '../sessions/sessions.service'
import { setTenantContext } from '../tenant-context'
import { PlacedOrderLineModifierView, PlacedOrderLineView, PlacedOrderView } from './orders.dtos'

type Tx = Prisma.TransactionClient

// Same channel guest/cart/cart.service.ts reads the cart against
// (PriceChannel.qr) - placement must snapshot the exact price the guest saw
// in their cart, not pos/orders' 'dine_in' channel.
const ORDER_PLACEMENT_PRICE_CHANNEL: PriceChannel = 'qr'

const CART_LINE_INCLUDE = {
  item: true,
  variant: true,
  modifiers: { include: { modifier: true } },
} satisfies Prisma.CartLineInclude

type CartLineWithRelations = Prisma.CartLineGetPayload<{ include: typeof CART_LINE_INCLUDE }>

// Duplicated from guest/cart/cart.service.ts (not exported - AD-2: cross-
// module/cross-file reach only through a module's own barrel) rather than a
// shared helper for one three-line check.
async function loadActiveSession(tx: Tx, guest: GuestPrincipal): Promise<TableSession> {
  const session = await tx.tableSession.findUnique({ where: { id: guest.sessionId } })
  if (!session) {
    throw new NotFoundException({ code: 'not_found', message: 'No such session' })
  }
  if (isSessionInactive(session)) {
    throw new GoneException({ code: 'session_closed', message: 'This table session has ended' })
  }
  return session
}

@Injectable()
export class GuestOrdersService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly tickets: KitchenTicketsService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async placeOrder(guest: GuestPrincipal): Promise<PlacedOrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await loadActiveSession(tx, guest)

      const cartLines: CartLineWithRelations[] = await tx.cartLine.findMany({
        where: { tenantId: guest.tenantId, sessionId: session.id },
        include: CART_LINE_INCLUDE,
        orderBy: { createdAt: 'asc' },
      })
      if (cartLines.length === 0) {
        throw new BadRequestException({ code: 'empty_cart', message: 'Add at least one item to the cart before placing the order' })
      }

      // pos/CAP-4 group ordering's all-lines-seated fire gate
      // (orders.service.ts's assertAllLinesSeated, private to that file) blocks
      // the open->sent transition while any OrderLine.seatNumber is null. A
      // guest table order has no staff-assigned "seat" step of its own, so each
      // distinct guest already in the session is auto-assigned one seat number
      // here, in join order (first guest = seat 1, second = seat 2, ...), and
      // every line inherits its adding guest's seat. This satisfies the gate by
      // construction rather than re-deriving or bypassing it - documented per
      // issue #77 scope, since "seat" here means "which guest", not a physical
      // chair.
      const guests = await tx.guest.findMany({ where: { tenantId: guest.tenantId, sessionId: session.id }, orderBy: { joinedAt: 'asc' } })
      const seatByGuest = new Map(guests.map((g, i) => [g.id, i + 1]))

      const order = await tx.order.create({
        data: {
          tenantId: guest.tenantId,
          outletId: guest.outletId,
          tableId: session.tableId,
          // No staff owner at creation - see Order.ownerId's schema comment for
          // why this is not a faked staff id. A staff member may take the order
          // over later via the existing transfer() action.
          ownerId: null,
          status: 'open',
          source: 'qr',
          sessionId: session.id,
        },
      })

      const lineViews: PlacedOrderLineView[] = []
      for (const line of cartLines) {
        // Re-resolved here rather than trusting whatever the cart last showed -
        // same insert-only, re-resolvable item_prices read (AD-11)
        // pos/orders/order-lines.service.ts uses, snapshotted for real only now,
        // at placement (see CartLine's schema comment on why the cart itself
        // never snapshots price).
        const price = await resolveCurrentPrice(tx, {
          tenantId: guest.tenantId,
          itemId: line.itemId,
          variantId: line.variantId,
          channel: ORDER_PLACEMENT_PRICE_CHANNEL,
          outletId: guest.outletId,
        })
        if (!price) {
          throw new BadRequestException({ code: 'no_price', message: 'No current price is configured for one of the items in this cart' })
        }

        const seatNumber = seatByGuest.get(line.guestId) ?? null
        const createdLine = await tx.orderLine.create({
          data: {
            tenantId: guest.tenantId,
            orderId: order.id,
            itemId: line.itemId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPriceMinor: price.priceMinor,
            seatNumber,
            // No staff adder - see OrderLine.addedByStaffId's schema comment.
            addedByStaffId: null,
            guestId: line.guestId,
            guestName: line.guestName,
          },
        })

        const modifierViews: PlacedOrderLineModifierView[] = []
        for (const cartModifier of line.modifiers) {
          await tx.orderLineModifier.create({
            data: { tenantId: guest.tenantId, orderLineId: createdLine.id, modifierId: cartModifier.modifierId, priceMinor: cartModifier.modifier.priceMinor },
          })
          modifierViews.push({ id: cartModifier.modifierId, name: cartModifier.modifier.name, priceMinor: Number(cartModifier.modifier.priceMinor) })
        }

        lineViews.push({
          id: createdLine.id,
          itemId: line.itemId,
          itemName: line.item.name,
          variantId: line.variantId,
          variantName: line.variant?.name ?? null,
          quantity: line.quantity,
          unitPriceMinor: Number(price.priceMinor),
          seatNumber,
          guestId: line.guestId,
          guestName: line.guestName,
          modifiers: modifierViews,
        })
      }

      // kitchen-display/CAP-1's open->sent transition (AD-16): the exact same
      // status flip + KitchenTicketsService.fireOnSend call, in the same
      // transaction, that pos/orders/orders.service.ts's updateStatus runs for
      // a staff order - AD-18's "same fire transition, same tickets" is this
      // line, not a description of behavior duplicated elsewhere.
      const sent = await tx.order.update({ where: { id: order.id }, data: { status: 'sent' } })
      await this.tickets.fireOnSend(tx, sent)

      // Placement consumes the cart - the table's real order now exists, the
      // cart that produced it has no further purpose. CartLineModifier rows
      // cascade at the DB level (cart_line_modifiers_cart_line_id_fkey ON
      // DELETE CASCADE), so deleting the CartLines is enough.
      await tx.cartLine.deleteMany({ where: { tenantId: guest.tenantId, sessionId: session.id } })

      return {
        orderId: sent.id,
        tableId: session.tableId,
        status: 'sent',
        source: 'qr',
        sessionId: session.id,
        lines: lineViews,
      }
    })
  }
}
