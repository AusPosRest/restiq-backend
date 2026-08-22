// Health endpoints only. Every address comes from the environment so that no
// hostname is ever written in source - see restiq-design/setup/01-dev-environment.md
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getPrisma } from './db/client.js'

const app = express()

// .env sets 8180 on the dev machine. This fallback matches Fly's internal_port,
// so fly.toml needs no [env] block.
const port = Number(process.env.PORT ?? 8080)

// Required, not defaulted: a silent fallback would allow the wrong origin in prod.
const webOrigin = process.env.WEB_ORIGIN
if (!webOrigin) {
  throw new Error('WEB_ORIGIN is not set - it must name the site allowed to call this API')
}

// credentials: the operator's session cookie will ride this same path.
app.use(cors({ origin: webOrigin, credentials: true }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'restiq-backend' })
})

// 503 rather than a 200 carrying bad news - health checks read the status code.
app.get('/health/db', (_req, res) => {
  getPrisma()
    .$queryRaw`select 1`
    .then(() => {
      res.json({ status: 'ok', database: 'reachable' })
    })
    .catch((error: unknown) => {
      console.error('database health check failed', error)
      res.status(503).json({ status: 'error', database: 'unreachable' })
    })
})

// 0.0.0.0, not localhost: Caddy reaches this from 192.168.1.41.
app.listen(port, '0.0.0.0', () => {
  console.log(`restiq-backend listening on 0.0.0.0:${port}`)
})
