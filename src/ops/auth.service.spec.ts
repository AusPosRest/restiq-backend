import { UnauthorizedException } from '@nestjs/common'
import * as argon2 from 'argon2'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlPlaneAuditEntry, ControlPlaneAuditService, PrismaService } from '../platform'
import { OpsAuthService } from './auth.service'

interface StoredOperator {
  id: string
  email: string
  passwordHash: string
  createdAt: Date
  updatedAt: Date
}

const OPERATOR_ID = '01920000-0000-7000-8000-000000000001'
const EMAIL = 'sunita@restiq.example'
const PASSWORD = 'correct-horse-battery'

describe('OpsAuthService', () => {
  let operator: StoredOperator
  let findUnique: ReturnType<typeof vi.fn>
  let auditEntries: ControlPlaneAuditEntry[]
  let service: OpsAuthService

  beforeAll(async () => {
    process.env.OPS_JWT_SECRET = 'unit-test-secret'
    operator = {
      id: OPERATOR_ID,
      email: EMAIL,
      passwordHash: await argon2.hash(PASSWORD),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  })

  beforeEach(() => {
    findUnique = vi.fn(({ where }: { where: { email: string } }): Promise<StoredOperator | null> => {
      return Promise.resolve(where.email === EMAIL ? operator : null)
    })
    auditEntries = []
    const prisma = { client: { operatorUser: { findUnique } } } as unknown as PrismaService
    const audit = {
      record: (entry: ControlPlaneAuditEntry): Promise<void> => {
        auditEntries.push(entry)
        return Promise.resolve()
      },
    } as ControlPlaneAuditService
    service = new OpsAuthService(prisma, audit)
  })

  it('returns a token and the operator for valid credentials, and audits the login', async () => {
    const result = await service.login(EMAIL, PASSWORD)
    expect(result.operator).toEqual({ id: OPERATOR_ID, email: EMAIL })
    expect(result.token).toBeTruthy()
    expect(auditEntries.map((e) => e.action)).toEqual(['operator.login.succeeded'])
    expect(auditEntries[0]?.actorId).toBe(OPERATOR_ID)
  })

  it('normalizes the email before lookup', async () => {
    await service.login(`  ${EMAIL.toUpperCase()}  `, PASSWORD)
    expect(findUnique).toHaveBeenCalledWith({ where: { email: EMAIL } })
  })

  it('rejects a wrong password with the generic message and audits the failure', async () => {
    const attempt = service.login(EMAIL, 'wrong-password')
    await expect(attempt).rejects.toThrow(UnauthorizedException)
    await expect(service.login(EMAIL, 'wrong-password')).rejects.toMatchObject({
      response: { code: 'invalid_credentials', message: 'Incorrect email or password' },
    })
    expect(auditEntries.map((e) => e.action)).toContain('operator.login.failed')
  })

  it('rejects an unknown email with the exact same generic error as a wrong password', async () => {
    const unknownEmail = service.login('nobody@restiq.example', PASSWORD).catch((e: unknown) => e)
    const wrongPassword = service.login(EMAIL, 'wrong-password').catch((e: unknown) => e)
    const [a, b] = await Promise.all([unknownEmail, wrongPassword])
    expect(a).toBeInstanceOf(UnauthorizedException)
    expect((a as UnauthorizedException).getResponse()).toEqual((b as UnauthorizedException).getResponse())
  })

  it('audits logout with the acting operator', async () => {
    await service.logout({ id: OPERATOR_ID, email: EMAIL })
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({ action: 'operator.logout', actorId: OPERATOR_ID, actorEmail: EMAIL })
  })
})
