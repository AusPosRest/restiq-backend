import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailService } from './mail.service'
import type { PrismaService } from './prisma.service'

const message = { to: 'anita@bayleaf.example', subject: 'Reset', text: 'Link: https://x', html: '<p>Link</p>' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('MailService', () => {
  it('sends nothing anywhere when the provider is log (the default)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await new MailService({} as PrismaService).send(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts one message to Mailjet with basic auth, the sender and both text parts', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'mailjet')
    vi.stubEnv('MAILJET_API_KEY', 'key')
    vi.stubEnv('MAILJET_API_SECRET', 'secret')
    vi.stubEnv('MAIL_FROM_EMAIL', 'no-reply@idelta.com.au')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await new MailService({} as PrismaService).send(message)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.mailjet.com/v3.1/send')
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`)
    expect(JSON.parse(init.body as string)).toEqual({
      Messages: [{ From: { Email: 'no-reply@idelta.com.au', Name: 'RESTIQ' }, To: [{ Email: message.to }], Subject: 'Reset', TextPart: message.text, HTMLPart: message.html }],
    })
  })

  it('fails loudly when Mailjet refuses the message or is half configured', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'mailjet')
    await expect(new MailService({} as PrismaService).send(message)).rejects.toThrow(/MAILJET_API_KEY/)
    vi.stubEnv('MAILJET_API_KEY', 'key')
    vi.stubEnv('MAILJET_API_SECRET', 'secret')
    vi.stubEnv('MAIL_FROM_EMAIL', 'no-reply@idelta.com.au')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(new MailService({} as PrismaService).send(message)).rejects.toThrow('Mailjet answered 401')
  })
})
