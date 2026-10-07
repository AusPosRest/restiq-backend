// Sends the platform's own emails (owner password reset today). Two providers, picked by
// MAIL_PROVIDER: `mailjet` (the real one, API key and secret in the environment) and `log`
// (the default: the message goes to the server log and nowhere else, for development and tests).
// Production refuses to start unless Mailjet is configured (production-config.ts).
import { Injectable, Logger } from '@nestjs/common'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

const MAILJET_SEND_URL = 'https://api.mailjet.com/v3.1/send'

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)

  async send(message: MailMessage): Promise<void> {
    if ((process.env.MAIL_PROVIDER ?? 'log') !== 'mailjet') {
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
}
