// Nest bootstrap. Every address comes from the environment so that no
// hostname is ever written in source - see restiq-design/setup/01-dev-environment.md
import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  // Required, not defaulted: a silent fallback would allow the wrong origin in prod.
  const webOrigin = process.env.WEB_ORIGIN
  if (!webOrigin) {
    throw new Error('WEB_ORIGIN is not set - it must name the site allowed to call this API')
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  // restiq-backend#171: sign-in throttling keys on the client IP (req.ip).
  // Behind a proxy that address is in X-Forwarded-For, which a client can
  // also write itself - so trust exactly the proxy hops we run behind (Fly's
  // edge = 1) and no more. Unset/0: use the socket address, ignore the header.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0)
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a whole number of proxy hops (0 = none)')
  }
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
  // credentials: the operator's session cookie rides this same path.
  app.enableCors({ origin: webOrigin, credentials: true })

  // .env sets 8180 on the dev machine. This fallback matches Fly's internal_port,
  // so fly.toml needs no [env] block.
  const port = Number(process.env.PORT ?? 8080)
  // 0.0.0.0, not localhost: Caddy reaches this from 192.168.1.41.
  await app.listen(port, '0.0.0.0')
  console.log(`restiq-backend listening on 0.0.0.0:${port}`)
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
