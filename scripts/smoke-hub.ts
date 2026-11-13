// Hub artifact smoke (#293, HUB-BUILD-PLAN H7): runs `pnpm build:hub` first.
// Seeds a temp PGlite data dir, starts `node dist-hub/hub.cjs` on it, waits for
// /health, then signs a cashier in by PIN and reads the menu. On windows-latest
// this proves the argon2 win32 prebuild and PGlite on NTFS.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_PIN, seedHubTenant } from '../test/hub-seed'
import { openStore } from '../src/hub/store'

const root = join(__dirname, '..')
const PORT = 18180
const base = `http://127.0.0.1:${PORT}`

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`smoke failed: ${message}`)
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq hub ')) // a space, as under %APPDATA% user names
  const { pg, prisma } = await openStore(dataDir, join(root, 'prisma', 'migrations'))
  const seed = await seedHubTenant(pg, prisma, 'Smoke')
  await prisma.$disconnect()
  await pg.close()

  const started = Date.now()
  const hub = spawn(process.execPath, [join(root, 'dist-hub', 'hub.cjs')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HUB_DATA_DIR: dataDir, HUB_PORT: String(PORT), POS_JWT_SECRET: 'smoke-secret' },
    stdio: 'inherit',
  })
  const exited = new Promise<number | null>((resolve) => hub.on('exit', resolve))
  try {
    let healthy = false
    while (!healthy && Date.now() - started < 30_000 && hub.exitCode === null) {
      healthy = await fetch(`${base}/health`).then((res) => res.ok, () => false)
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check(healthy, 'hub never answered /health')
    console.log(`hub healthy in ${Date.now() - started} ms`)

    const login = await fetch(`${base}/pos/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: seed.tenantId, pin: HUB_PIN }) })
    const body = (await login.json()) as { status?: string; token?: string }
    check(login.status === 200 && body.status === 'authenticated' && typeof body.token === 'string', `PIN login answered ${login.status} ${JSON.stringify(body)}`)

    const menu = await fetch(`${base}/pos/v1/menu`, { headers: { authorization: `Bearer ${body.token}` } })
    const items = ((await menu.json()) as { items?: { id: string }[] }).items ?? []
    check(menu.status === 200 && items.some((item) => item.id === seed.itemId), `menu answered ${menu.status}`)

    const off = await fetch(`${base}/sync/v1/bootstrap`)
    check(off.status === 404, `off-allowlist route answered ${off.status}`)
    console.log('hub smoke passed')
  } finally {
    hub.kill()
    await exited
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
