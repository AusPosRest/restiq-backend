// DocuSign eSignature REST v2.1 client (issue #150). JWT-grant auth; one
// envelope per signing attempt - the owner signs embedded in the console
// (clientUserId), then the platform's authorised signatory countersigns by
// email. DocuSign renders the HTML document to PDF, seals it, and returns it
// with its Certificate of Completion. Config is env-only and every value is
// required: anything missing fails closed with 503 esign_unavailable, never a
// fallback to an unsealed signature.
import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import jwt from 'jsonwebtoken'
import { ANCHORS } from './agreement-document'

export interface EnvelopeSigner {
  name: string
  email: string
  clientUserId: string
}

export interface EnvelopeState {
  /** DocuSign's envelope status: sent, delivered, completed, declined, voided, ... */
  status: string
  /** When the owner (recipient 1) signed, if they have. */
  ownerSignedAt: Date | null
  completedAt: Date | null
}

interface DocuSignConfig {
  integrationKey: string
  userId: string
  accountId: string
  privateKey: string
  oauthHost: string
  basePath: string
  countersigner: { name: string; email: string; title: string }
}

const UNAVAILABLE = { code: 'esign_unavailable', message: 'Electronic signing is not set up yet. Contact Restiq support.' }
const FAILED = { code: 'esign_failed', message: 'DocuSign could not complete the request. Try again in a moment.' }

function env(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function anchorTab(anchorString: string) {
  return { anchorString, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }
}

@Injectable()
export class DocuSignClient {
  private readonly logger = new Logger(DocuSignClient.name)
  private token: { value: string; expiresAt: number } | null = null

  config(): DocuSignConfig {
    const config: DocuSignConfig = {
      integrationKey: env('DOCUSIGN_INTEGRATION_KEY'),
      userId: env('DOCUSIGN_USER_ID'),
      accountId: env('DOCUSIGN_ACCOUNT_ID'),
      // One env line: literal "\n" sequences in the PEM stand for newlines.
      privateKey: env('DOCUSIGN_PRIVATE_KEY').replace(/\\n/g, '\n'),
      oauthHost: env('DOCUSIGN_OAUTH_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      basePath: env('DOCUSIGN_BASE_PATH').replace(/\/+$/, ''),
      countersigner: {
        name: env('DOCUSIGN_COUNTERSIGNER_NAME'),
        email: env('DOCUSIGN_COUNTERSIGNER_EMAIL'),
        title: env('DOCUSIGN_COUNTERSIGNER_TITLE') || 'Authorised Signatory',
      },
    }
    const required = [config.integrationKey, config.userId, config.accountId, config.privateKey, config.oauthHost, config.basePath, config.countersigner.name, config.countersigner.email]
    if (required.some((value) => value === '')) throw new ServiceUnavailableException(UNAVAILABLE)
    return config
  }

  async createEnvelope(input: { emailSubject: string; documentName: string; html: string; signer: EnvelopeSigner }): Promise<string> {
    const { countersigner } = this.config()
    const response = await this.api('/envelopes', {
      method: 'POST',
      body: JSON.stringify({
        emailSubject: input.emailSubject.slice(0, 100),
        documents: [{ documentId: '1', name: input.documentName, fileExtension: 'html', documentBase64: Buffer.from(input.html, 'utf8').toString('base64') }],
        recipients: {
          signers: [
            {
              recipientId: '1',
              routingOrder: '1',
              name: input.signer.name,
              email: input.signer.email,
              clientUserId: input.signer.clientUserId,
              tabs: { signHereTabs: [anchorTab(ANCHORS.customerSign)], dateSignedTabs: [anchorTab(ANCHORS.customerDate)] },
            },
            {
              recipientId: '2',
              routingOrder: '2',
              name: countersigner.name,
              email: countersigner.email,
              tabs: { signHereTabs: [anchorTab(ANCHORS.platformSign)], dateSignedTabs: [anchorTab(ANCHORS.platformDate)] },
            },
          ],
        },
        status: 'sent',
      }),
    })
    return ((await response.json()) as { envelopeId: string }).envelopeId
  }

  /** A one-time DocuSign URL (valid a few minutes) that opens the owner's signing session. */
  async signingUrl(envelopeId: string, signer: EnvelopeSigner, returnUrl: string): Promise<string> {
    const response = await this.api(`/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`, {
      method: 'POST',
      // 'password': how our console authenticated the owner before handing them to DocuSign.
      body: JSON.stringify({ returnUrl, authenticationMethod: 'password', email: signer.email, userName: signer.name, clientUserId: signer.clientUserId }),
    })
    return ((await response.json()) as { url: string }).url
  }

  async envelopeState(envelopeId: string): Promise<EnvelopeState> {
    const response = await this.api(`/envelopes/${encodeURIComponent(envelopeId)}?include=recipients`)
    const body = (await response.json()) as {
      status: string
      completedDateTime?: string
      recipients?: { signers?: Array<{ recipientId: string; status: string; signedDateTime?: string }> }
    }
    const owner = body.recipients?.signers?.find((signer) => signer.recipientId === '1')
    const ownerSigned = owner !== undefined && owner.signedDateTime !== undefined && (owner.status === 'completed' || owner.status === 'signed')
    return {
      status: body.status,
      ownerSignedAt: ownerSigned && owner.signedDateTime ? new Date(owner.signedDateTime) : null,
      completedAt: body.completedDateTime ? new Date(body.completedDateTime) : null,
    }
  }

  /** The completed envelope as one PDF, DocuSign's Certificate of Completion appended. */
  async completedPdf(envelopeId: string): Promise<Buffer> {
    const response = await this.api(`/envelopes/${encodeURIComponent(envelopeId)}/documents/combined?certificate=true`)
    return Buffer.from(await response.arrayBuffer())
  }

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const config = this.config()
    const token = await this.accessToken(config)
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (init.body) headers['content-type'] = 'application/json'
    return this.send(`${config.basePath}/v2.1/accounts/${encodeURIComponent(config.accountId)}${path}`, { ...init, headers })
  }

  private async accessToken(config: DocuSignConfig): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value
    let assertion: string
    try {
      assertion = jwt.sign({ iss: config.integrationKey, sub: config.userId, aud: config.oauthHost, scope: 'signature impersonation' }, config.privateKey, {
        algorithm: 'RS256',
        expiresIn: 3600,
      })
    } catch (error) {
      this.logger.error(`DOCUSIGN_PRIVATE_KEY is not a usable RSA key: ${String(error)}`)
      throw new ServiceUnavailableException(UNAVAILABLE)
    }
    const response = await this.send(`https://${config.oauthHost}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    const body = (await response.json()) as { access_token: string; expires_in: number }
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return body.access_token
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      this.logger.error(`DocuSign unreachable: ${String(error)}`)
      throw new BadGatewayException(FAILED)
    }
    if (!response.ok) {
      // e.g. consent_required when the JWT grant has not been consented yet - the body names the cause.
      const detail = await response.text().catch(() => '')
      this.logger.error(`DocuSign ${init.method ?? 'GET'} ${new URL(url).pathname} -> ${response.status}: ${detail.slice(0, 500)}`)
      throw new BadGatewayException(FAILED)
    }
    return response
  }
}
