import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookAlertChannel } from './alert-channel'

const ALERT = { deviceId: 'd1', tenantId: 't1', outletId: 'o1', lastContactAt: '2026-09-22T01:00:00.000Z', lagSeconds: 7 * 3600 }

describe('WebhookAlertChannel (#175)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fetchMock.mockReset()
  })
  afterEach(() => {
    delete process.env.ALERT_WEBHOOK_URL
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the alert as JSON to the configured webhook, and logs it', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc'
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await new WebhookAlertChannel().notifySilentDevice(ALERT)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://hooks.example/abc')
    const body = JSON.parse(init.body as string) as { text: string; alert: { type: string; deviceId: string } }
    expect(body.text).toContain('device d1')
    expect(body.text).toContain('silent for 7h')
    expect(body.alert).toMatchObject({ type: 'silent_device', deviceId: 'd1' })
    expect(console.warn).toHaveBeenCalled()
  })

  it('only logs when no webhook is configured', async () => {
    await new WebhookAlertChannel().notifySilentDevice(ALERT)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it('never throws when the webhook is down or refuses', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc'
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(new WebhookAlertChannel().notifySilentDevice(ALERT)).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await expect(new WebhookAlertChannel().notifySilentDevice(ALERT)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledTimes(2)
  })
})
