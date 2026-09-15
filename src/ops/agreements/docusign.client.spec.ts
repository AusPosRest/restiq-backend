import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANCHORS } from './agreement-document'
import { DocuSignClient } from './docusign.client'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const ENV: Record<string, string> = {
  DOCUSIGN_INTEGRATION_KEY: 'ik-123',
  DOCUSIGN_USER_ID: 'user-456',
  DOCUSIGN_ACCOUNT_ID: 'acct-789',
  DOCUSIGN_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
  DOCUSIGN_OAUTH_HOST: 'account-d.docusign.com',
  DOCUSIGN_BASE_PATH: 'https://demo.docusign.net/restapi/',
  DOCUSIGN_COUNTERSIGNER_NAME: 'Priya Menon',
  DOCUSIGN_COUNTERSIGNER_EMAIL: 'legal@restiq.example',
}

const SIGNER = { name: 'Asha Rao', email: 'asha@bistro.example', clientUserId: 'owner-1' }

interface EnvelopePayload {
  emailSubject: string
  status: string
  documents: Array<{ documentBase64: string; fileExtension: string }>
  recipients: {
    signers: Array<{ routingOrder: string; name: string; email: string; clientUserId?: string; tabs: { signHereTabs: Array<{ anchorString: string }>; dateSignedTabs: Array<{ anchorString: string }> } }>
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubDocuSign(handler: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(url.endsWith('/oauth/token') ? json({ access_token: 'tok', expires_in: 3600 }) : handler(url, init)),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('DocuSignClient', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('fails closed with 503 esign_unavailable when a setting is missing, without calling DocuSign', async () => {
    vi.stubEnv('DOCUSIGN_COUNTERSIGNER_EMAIL', '')
    const fetchMock = stubDocuSign(() => json({}))
    await expect(new DocuSignClient().createEnvelope({ emailSubject: 's', documentName: 'd.html', html: '<p/>', signer: SIGNER })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gets a JWT-grant token, then sends the HTML with the owner embedded first and the countersigner second', async () => {
    const fetchMock = stubDocuSign(() => json({ envelopeId: 'env-1' }, 201))
    const client = new DocuSignClient()
    expect(await client.createEnvelope({ emailSubject: 'Please sign', documentName: 'Agreement v1.html', html: '<p>Hi</p>', signer: SIGNER })).toBe('env-1')

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://account-d.docusign.com/oauth/token')
    const form = new URLSearchParams(tokenInit.body as string)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(jwt.verify(form.get('assertion') ?? '', publicKey, { algorithms: ['RS256'] })).toMatchObject({
      iss: 'ik-123',
      sub: 'user-456',
      aud: 'account-d.docusign.com',
      scope: 'signature impersonation',
    })

    const [envelopeUrl, envelopeInit] = fetchMock.mock.calls[1]
    expect(envelopeUrl).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-789/envelopes')
    expect(envelopeInit.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' })
    const payload = JSON.parse(envelopeInit.body as string) as EnvelopePayload
    expect(payload.status).toBe('sent')
    expect(payload.documents[0].fileExtension).toBe('html')
    expect(Buffer.from(payload.documents[0].documentBase64, 'base64').toString('utf8')).toBe('<p>Hi</p>')
    const [owner, restiq] = payload.recipients.signers
    expect(owner).toMatchObject({ routingOrder: '1', name: 'Asha Rao', email: 'asha@bistro.example', clientUserId: 'owner-1' })
    expect(owner.tabs.signHereTabs[0].anchorString).toBe(ANCHORS.customerSign)
    expect(owner.tabs.dateSignedTabs[0].anchorString).toBe(ANCHORS.customerDate)
    expect(restiq).toMatchObject({ routingOrder: '2', name: 'Priya Menon', email: 'legal@restiq.example' })
    expect(restiq.clientUserId).toBeUndefined()
    expect(restiq.tabs.signHereTabs[0].anchorString).toBe(ANCHORS.platformSign)

    // The token is reused until it nears expiry.
    await client.envelopeState('env-1').catch(() => undefined)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  it("reads the owner's signature from recipient 1 and the completion time", async () => {
    stubDocuSign(() =>
      json({
        status: 'sent',
        recipients: { signers: [{ recipientId: '1', status: 'completed', signedDateTime: '2026-09-15T10:00:00Z' }, { recipientId: '2', status: 'sent' }] },
      }),
    )
    expect(await new DocuSignClient().envelopeState('env-1')).toEqual({ status: 'sent', ownerSignedAt: new Date('2026-09-15T10:00:00Z'), completedAt: null })
  })

  it('maps a DocuSign error to 502 esign_failed', async () => {
    stubDocuSign(() => json({ errorCode: 'ENVELOPE_DOES_NOT_EXIST' }, 400))
    await expect(new DocuSignClient().completedPdf('nope')).rejects.toBeInstanceOf(BadGatewayException)
  })
})
