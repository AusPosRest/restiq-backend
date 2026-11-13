// The child process src/hub/recovery.spec.ts kills (#306, the PGlite spike's
// crash test on the real hub): boots the hub on a data dir the way hub-main
// does (recovery included), prints "ready", then rings up counter sales -
// order, line, bill, cash finalize - through the hub's HTTP API until killed,
// printing "sold" after each finalized sale.
// Run: node -r ./test/swc-register.cjs test/hub-sale-loop.ts <dataDir> <tenantId> <outletId> <itemId>
import { join } from 'node:path'
import request from 'supertest'
import { bootHub } from './hub-boot'
import { HUB_PIN } from './hub-seed'

async function main(): Promise<void> {
  const [dataDir, tenantId, outletId, itemId] = process.argv.slice(2)
  process.env.POS_JWT_SECRET = 'hub-sale-loop-secret'
  const { app } = await bootHub(dataDir, join(__dirname, '..', 'prisma', 'migrations'))
  const http = app.getHttpServer() as Parameters<typeof request>[0]
  const login = await request(http).post('/pos/v1/auth/login').send({ tenantId, pin: HUB_PIN }).expect(200)
  const auth = { Authorization: `Bearer ${(login.body as { token: string }).token}` }
  const post = (path: string, body?: object) => request(http).post(path).set(auth).send(body)
  const shift = await post('/pos/v1/shifts', { outletId, floatMinor: 50000 })
  if (shift.status !== 201 && shift.status !== 409) throw new Error(`shift open answered ${shift.status}`)
  console.log('ready')
  for (;;) {
    const order = (await post(`/pos/v1/outlets/${outletId}/counter-orders`).expect(201)).body as { id: string }
    await post(`/pos/v1/orders/${order.id}/lines`, { itemId, quantity: 1 }).expect(201)
    const bill = (await post(`/pos/v1/orders/${order.id}/bill`).expect(201)).body as { id: string; totalMinor: number }
    await post(`/pos/v1/bills/${bill.id}/finalize`, { tenders: [{ method: 'cash', amountMinor: bill.totalMinor }] }).expect(200)
    console.log('sold')
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
