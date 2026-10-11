// Shapes every error as { error: { code, message } } (workspace API error
// convention) so clients branch on a machine-readable code - including the
// ones no handler expected (restiq-backend#209, SE-30): a database clash
// answers 409/400 with a code, anything else a logged 500 internal_error,
// never Nest's default { statusCode, message } body.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { Response } from 'express'

// Prisma error codes worth a better answer than 500. P2034: write conflict or deadlock (two requests raced);
// P2002: a unique value already taken; P2020: a number too large for its column.
const PRISMA_ERRORS: Readonly<Record<string, { status: number; code: string; message: string }>> = {
  P2034: { status: 409, code: 'conflict', message: 'Someone else changed this at the same time - try again' },
  P2002: { status: 409, code: 'conflict', message: 'This already exists' },
  P2020: { status: 400, code: 'validation_failed', message: 'A number is too large' },
}

function prismaCode(exception: unknown): string | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined
  const { code, name } = exception as { code?: unknown; name?: unknown }
  return typeof code === 'string' && typeof name === 'string' && name.startsWith('PrismaClient') ? code : undefined
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    if (!(exception instanceof HttpException)) {
      const known = PRISMA_ERRORS[prismaCode(exception) ?? '']
      if (!known || known.status >= 500) this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception))
      const { status, code, message } = known ?? { status: 500, code: 'internal_error', message: 'Something went wrong on our side - try again' }
      response.status(status).json({ error: { code, message } })
      return
    }
    const body = exception.getResponse()

    let code = 'error'
    let message = exception.message
    let extra: Record<string, unknown> = {}
    if (typeof body === 'object') {
      const b = body as Record<string, unknown>
      if (typeof b.code === 'string') code = b.code
      if (typeof b.message === 'string') {
        message = b.message
      } else if (Array.isArray(b.message)) {
        // ValidationPipe emits message: string[]
        code = code === 'error' ? 'validation_failed' : code
        message = b.message.filter((m): m is string => typeof m === 'string').join('; ')
      }
      // Any other machine-readable detail an exception attaches (e.g. the
      // go-live checklist's missingSteps) rides along next to code/message.
      extra = Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'code' && key !== 'message'))
    }

    response.status(exception.getStatus()).json({ error: { code, message, ...extra } })
  }
}
