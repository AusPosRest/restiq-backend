// Health endpoints, carried over from the Express bootstrap unchanged in
// contract: /health answers unconditionally, /health/db proves the database
// through Prisma - health checks read the status code, not the body.
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from './platform'

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'restiq-backend' }
  }

  @Get('db')
  async db(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.client.$queryRaw`select 1`
      return { status: 'ok', database: 'reachable' }
    } catch (error: unknown) {
      console.error('database health check failed', error)
      throw new ServiceUnavailableException({ code: 'database_unreachable', message: 'database unreachable' })
    }
  }
}
