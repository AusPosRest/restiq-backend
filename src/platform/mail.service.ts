// Sends the platform's own emails (owner password reset and owner invites). Three providers, picked by
// MAIL_PROVIDER: `mailjet` (the real one, API key and secret in the environment), `simulator` (#198: the
// message is stored in simulated_messages and shown by the dev inbox, GET /ops/v1/dev-inbox) and `log`
// (the default: the message goes to the server log and nowhere else, for tests).
// Production refuses to start unless Mailjet is configured (production-config.ts).
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from './prisma.service'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface InboxMessage extends MailMessage {
  id: string
  sentAt: string
}

const MAILJET_SEND_URL = 'https://api.mailjet.com/v3.1/send'
const INBOX_LIMIT = 100

/** An absolute link into the web app, for emails. */
export function webLink(path: string): string {
  return `${(process.env.ADMIN_APP_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:3100').replace(/\/$/, '')}${path}`
}

const provider = (): string => process.env.MAIL_PROVIDER ?? 'log'

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)

  constructor(private readonly prisma: PrismaService) {}

  async send(message: MailMessage): Promise<void> {
    if (provider() === 'simulator') {
      await this.prisma.client.simulatedMessage.create({ data: { to: message.to, subject: message.subject, text: message.text, html: message.html } })
      this.logger.log(`[mail:simulator] to=${message.to} subject="${message.subject}"`)
      return
    }
    if (provider() !== 'mailjet') {
      this.logger.log(`[mail:log] to=${message.to} subject="${message.subject}"\n${message.text}`)
      return
    }
    const { MAILJET_API_KEY: key, MAILJET_API_SECRET: secret, MAIL_FROM_EMAIL: from } = process.env
    if (!key || !secret || !from) throw new Error('MAIL_PROVIDER=mailjet needs MAILJET_API_KEY, MAILJET_API_SECRET and MAIL_FROM_EMAIL')
    const response = await fetch(MAILJET_SEND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: from, Name: process.env.MAIL_FROM_NAME ?? 'RESTIQ' },
            To: [{ Email: message.to }],
            Subject: message.subject,
            TextPart: message.text,
            ...(message.html ? { HTMLPart: message.html } : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Mailjet answered ${response.status}`)
  }

  /** The simulator's newest messages, optionally for one address. 404 unless the simulator is the provider. */
  async inbox(to?: string): Promise<InboxMessage[]> {
    if (provider() !== 'simulator') throw new NotFoundException({ code: 'not_found', message: 'The mail simulator is off' })
    const rows = await this.prisma.client.simulatedMessage.findMany({
      where: to ? { to: { equals: to.trim(), mode: 'insensitive' } } : {},
      orderBy: { createdAt: 'desc' },
      take: INBOX_LIMIT,
    })
    return rows.map((row) => ({ id: row.id, to: row.to, subject: row.subject, text: row.text, html: row.html ?? undefined, sentAt: row.createdAt.toISOString() }))
  }
}
