// Hub mode (#293): the routes the POS and KDS screens call (HUB-BUILD-PLAN §1),
// and nothing else. Every other request answers 404 not_on_hub, whatever the
// Nest module graph happens to mount.
import type { NextFunction, Request, Response } from 'express'

export const ROUTES = [
  'GET /health',
  // Auth
  'POST /pos/v1/auth/login',
  'POST /pos/v1/auth/select-outlet',
  'POST /pos/v1/auth/logout',
  // Reads
  'GET /pos/v1/menu',
  'GET /pos/v1/tenant',
  'GET /pos/v1/outlets/:o/table-map',
  'GET /pos/v1/outlets/:o/orders',
  'GET /pos/v1/orders/:id',
  'GET /pos/v1/bills/:id',
  'GET /pos/v1/bills/:id/invoice',
  'GET /pos/v1/outlets/:o/payments',
  'GET /pos/v1/outlets/:o/print-jobs',
  'GET /pos/v1/outlets/:o/attendance',
  'GET /pos/v1/shifts/current',
  'GET /pos/v1/shifts/:id',
  'GET /pos/v1/outlets/:o/payment-intents',
  'GET /pos/v1/outlets/:o/card-readers',
  'GET /pos/v1/bills/:id/intents/active',
  'GET /pos/v1/payment-intents/:id',
  'GET /kitchen/v1/outlets/:o/stations',
  'GET /kitchen/v1/outlets/:o/stations/:s/queue',
  'GET /kitchen/v1/outlets/:o/expo',
  'GET /kitchen/v1/outlets/:o/bumped',
  'GET /kitchen/v1/outlets/:o/all-day-summary',
  // Hub status and Sync issues (H6) - hub-only
  'GET /pos/v1/hub/status',
  'GET /pos/v1/hub/rejections',
  'POST /pos/v1/hub/rejections/:op/acknowledge',
  // Orders and bills
  'POST /pos/v1/outlets/:o/tables/:t/order',
  'POST /pos/v1/outlets/:o/counter-orders',
  'POST /pos/v1/orders/:id/lines',
  'PATCH /pos/v1/orders/:id/lines/:l',
  'DELETE /pos/v1/orders/:id/lines/:l',
  'POST /pos/v1/orders/:id/lines/:l/void',
  'POST /pos/v1/orders/:id/combos',
  'PATCH /pos/v1/orders/:id/status',
  'POST /pos/v1/orders/:id/transfer',
  'DELETE /pos/v1/orders/:id',
  'POST /pos/v1/orders/:id/bill',
  'POST /pos/v1/bills/:id/finalize',
  'POST /pos/v1/bills/:id/refund',
  'POST /pos/v1/bills/:id/print',
  'POST /pos/v1/print-jobs/:id/printed',
  // Shifts, clock, tables, devices
  'POST /pos/v1/shifts',
  'POST /pos/v1/shifts/:id/cash-movements',
  'POST /pos/v1/shifts/:id/close',
  'POST /pos/v1/clock/out',
  'POST /pos/v1/tables/:t/close-session',
  'POST /pos/v1/devices/:id/heartbeat',
  // Card payments: mounted so the screens get a clean answer; Stripe calls 503 payments_not_configured on the hub.
  'POST /pos/v1/bills/:id/intents',
  'POST /pos/v1/payment-intents/:id/cancel',
  'POST /pos/v1/payment-intents/:id/simulate',
  // Kitchen
  'POST /kitchen/v1/tickets/:id/bump',
  'POST /kitchen/v1/tickets/:id/recall',
  'POST /kitchen/v1/tickets/:id/refire',
]

const PATTERNS = ROUTES.map((route) => {
  const [method, path] = route.split(' ')
  return { method, path: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}/?$`) }
})

export function isOnHub(method: string, path: string): boolean {
  return PATTERNS.some((route) => route.method === method && route.path.test(path))
}

/** Express middleware, installed ahead of every Nest route. */
export function hubAllowlist(req: Request, res: Response, next: NextFunction): void {
  if (isOnHub(req.method, req.path)) return next()
  res.status(404).json({ error: { code: 'not_on_hub', message: 'This is not available on the offline hub' } })
}
