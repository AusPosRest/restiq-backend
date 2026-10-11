import { ArgumentsHost, ConflictException, Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ApiErrorFilter } from './api-error.filter'

function run(exception: unknown): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown }
  const response = {
    status(code: number) {
      out.status = code
      return this
    },
    json(body: unknown) {
      out.body = body
    },
  }
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost
  new ApiErrorFilter().catch(exception, host)
  return out
}

describe('ApiErrorFilter (restiq-backend#209, SE-30)', () => {
  it('keeps the shape for HttpExceptions', () => {
    expect(run(new ConflictException({ code: 'bill_finalized', message: 'Already final' }))).toEqual({ status: 409, body: { error: { code: 'bill_finalized', message: 'Already final' } } })
  })

  it('answers an unexpected error with the documented shape, not Nest\'s default body', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    expect(run(new Error('boom'))).toEqual({ status: 500, body: { error: { code: 'internal_error', message: 'Something went wrong on our side - try again' } } })
  })

  it('turns a database deadlock / write conflict into a retryable 409', () => {
    const deadlock = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { name: 'PrismaClientKnownRequestError', code: 'P2034' })
    expect(run(deadlock)).toEqual({ status: 409, body: { error: { code: 'conflict', message: 'Someone else changed this at the same time - try again' } } })
  })
})
