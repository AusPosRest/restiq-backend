// #198: the mail simulator's inbox, for testing without Mailjet. restiq-backend#203: lives under /ops/* so the
// global OpsAuthGuard requires an operator session. #213: with a real provider (production) it holds only the
// mail of tenants in Test mode, so a real restaurant's invite and reset links never appear here.
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
