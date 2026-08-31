// Nest bootstrap. Every address comes from the environment so that no
// hostname is ever written in source - see restiq-design/setup/01-dev-environment.md
import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  // Required, not defaulted: a silent fallback would allow the wrong origin in prod.
  const webOrigin = process.env.WEB_ORIGIN
  if (!webOrigin) {
    throw new Error('WEB_ORIGIN is not set - it must name the site allowed to call this API')
  }

  const app = await NestFactory.create(AppModule)
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
