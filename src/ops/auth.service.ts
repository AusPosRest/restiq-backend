import { Injectable, UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { ControlPlaneAuditService, OpsPrincipal, PrismaService, signOpsToken } from '../platform'

export interface LoginResult {
  token: string
  operator: OpsPrincipal
}

@Injectable()
export class OpsAuthService {
  // Verified when the email is unknown so both failure paths cost one argon2
  // verify - no user enumeration via response timing.
  private dummyHash?: Promise<string>

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = email.trim().toLowerCase()
    const user = await this.prisma.client.operatorUser.findUnique({ where: { email: normalized } })

    const hash = user?.passwordHash ?? (await (this.dummyHash ??= argon2.hash('not-a-real-password')))
    const verified = await argon2.verify(hash, password)

    if (!user || !verified) {
      await this.audit.record({ actorEmail: normalized, action: 'operator.login.failed', occurredAt: new Date() })
      // Generic on purpose: never reveal which of email/password was wrong.
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Incorrect email or password' })
    }

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'operator.login.succeeded',
      occurredAt: new Date(),
    })
    const operator: OpsPrincipal = { id: user.id, email: user.email }
    return { token: signOpsToken(operator), operator }
  }

  async logout(operator: OpsPrincipal): Promise<void> {
    await this.audit.record({
      actorId: operator.id,
      actorEmail: operator.email,
      action: 'operator.logout',
      occurredAt: new Date(),
    })
  }
}
