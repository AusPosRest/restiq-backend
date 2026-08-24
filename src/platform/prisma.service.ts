// Nest-managed handle over the existing shared Prisma client (src/db/client.ts)
// so modules take it by injection and shutdown disconnects the pool.
import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { disconnectPrisma, getPrisma, PrismaClient } from '../db/client'

@Injectable()
export class PrismaService implements OnModuleDestroy {
  get client(): PrismaClient {
    return getPrisma()
  }

  async onModuleDestroy(): Promise<void> {
    await disconnectPrisma()
  }
}
