// Hub build artifact (#293, HUB-BUILD-PLAN H7): dist-hub/{hub.cjs, migrations/,
// package.json, node_modules/} for the Windows app to run with Electron's Node.
// tsc first (nest build) because Nest's DI needs the decorator metadata esbuild
// cannot emit; esbuild then bundles the compiled entry into one file. argon2
// (native prebuilds) and PGlite (wasm + data files) stay external and are
// installed next to the bundle.
import { execSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(__dirname, '..')
const out = join(root, 'dist-hub')
const EXTERNAL = ['argon2', '@electric-sql/pglite']
// Nest's optional peers, loaded with try/require only when used - never on the hub.
const OPTIONAL_PEERS = ['@nestjs/microservices', '@nestjs/microservices/*', '@nestjs/websockets', '@nestjs/websockets/*', 'class-transformer/storage', '@fastify/static', '@nestjs/platform-socket.io']

function installedVersion(name: string): string {
  return (JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version
}

async function main(): Promise<void> {
  // nest build empties dist/ but tsc's incremental state lives outside it, so a second build would emit nothing.
  rmSync(join(root, 'tsconfig.tsbuildinfo'), { force: true })
  // execSync runs through a shell, so Windows finds pnpm/npm as .cmd shims.
  execSync('pnpm run build', { cwd: root, stdio: 'inherit' })
  rmSync(out, { recursive: true, force: true })

  await build({
    entryPoints: [join(root, 'dist', 'hub', 'hub-main.js')],
    outfile: join(out, 'hub.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: [...EXTERNAL, ...OPTIONAL_PEERS],
    // Class names show in Nest's DI errors and logs.
    keepNames: true,
    logLevel: 'warning',
  })

  cpSync(join(root, 'prisma', 'migrations'), join(out, 'migrations'), { recursive: true })
  const dependencies = Object.fromEntries(EXTERNAL.map((name) => [name, installedVersion(name)]))
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'restiq-hub', private: true, main: 'hub.cjs', dependencies }, null, 2)}\n`)
  // --ignore-scripts: argon2 loads its shipped prebuild (win32-x64 included) at runtime; never compile on install.
  execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: out, stdio: 'inherit' })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
