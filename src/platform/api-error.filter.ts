// Shapes every HttpException as { error: { code, message } } (workspace API
// error convention) so clients branch on a machine-readable code.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common'
import type { Response } from 'express'

@Catch(HttpException)
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const body = exception.getResponse()

    let code = 'error'
    let message = exception.message
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
    }

    response.status(exception.getStatus()).json({ error: { code, message } })
  }
}
