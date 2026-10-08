// #198: the mail simulator's inbox, for testing without Mailjet. Answers 404 unless MAIL_PROVIDER=simulator,
// which production never allows (production-config.ts), so password-reset and invite links stay private there.
// restiq-backend#203: lives under /ops/* so the global OpsAuthGuard requires an operator session too.
import { Controller, Get, Query } from '@nestjs/common'
import { InboxMessage, MailService } from './platform'

@Controller('ops/v1/dev-inbox')
export class DevInboxController {
  constructor(private readonly mail: MailService) {}

  @Get()
  async list(@Query('to') to?: string): Promise<{ messages: InboxMessage[] }> {
    return { messages: await this.mail.inbox(to) }
  }
}
