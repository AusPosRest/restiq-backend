// Agreement text -> the HTML document DocuSign renders into the signed PDF
// (issue #150). The body is plain text with one small, fixed markup: a
// block's leading "# ", "## ", "### " lines are headings, blank lines separate
// paragraphs, single newlines are kept. Everything is HTML-escaped before it
// is placed, so agreement text can never inject markup into the signed
// document. {{customer.*}} fields are filled from the tenant; the signature
// block is appended here so the anchors the envelope's tabs look for exist
// exactly once. restiq-web's AgreementDocument renders the same markup.

export const ANCHORS = {
  customerSign: '/rq-sign-customer/',
  customerDate: '/rq-date-customer/',
  platformSign: '/rq-sign-restiq/',
  platformDate: '/rq-date-restiq/',
} as const

export interface CustomerFields {
  legalName: string
  address: string
  country: 'AU' | 'IN'
  taxId: string | null
}

export interface SigningParty {
  name: string
  title: string
}

const COUNTRY_NAME: Record<CustomerFields['country'], string> = { AU: 'Australia', IN: 'India' }

const STYLE = `
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #111; margin: 0 14mm; }
.meta { text-align: center; color: #555; font-size: 9pt; margin: 0; }
h1.title { text-align: center; font-size: 18pt; margin: 4pt 0 16pt; }
h1 { font-size: 13pt; margin: 18pt 0 6pt; }
h2 { font-size: 11.5pt; margin: 12pt 0 4pt; }
h3 { font-size: 11pt; margin: 10pt 0 4pt; }
p { margin: 0 0 8pt; }
table.sign { width: 100%; border-collapse: collapse; margin-top: 12pt; page-break-inside: avoid; }
table.sign td { width: 50%; vertical-align: top; padding: 10pt; border: 1px solid #999; }
.party { font-weight: bold; }
.line { height: 44pt; border-bottom: 1px solid #111; margin: 8pt 0 6pt; }
.anchor { color: #ffffff; font-size: 8pt; }
`

// Escapes, and drops any anchor string so a tab can only land in the signature block.
function text(value: string): string {
  const stripped = Object.values(ANCHORS).reduce((acc, anchor) => acc.split(anchor).join(''), value)
  return stripped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Fills {{customer.*}} fields; any other {{...}} is left as written. */
export function mergeCustomerFields(body: string, customer: CustomerFields): string {
  const values: Record<string, string> = {
    'customer.legalName': customer.legalName,
    'customer.address': customer.address,
    'customer.country': COUNTRY_NAME[customer.country],
    'customer.taxId': customer.taxId ?? 'not provided',
  }
  return body.replace(/\{\{\s*([A-Za-z.]+)\s*\}\}/g, (match, key: string) => values[key] ?? match)
}

function renderBlock(block: string): string {
  const [first, ...rest] = block.split('\n')
  const heading = /^(#{1,3})[ \t]+(.+)$/.exec(first)
  if (!heading) return `<p>${block.split('\n').map(text).join('<br>')}</p>`
  const level = heading[1].length
  const html = `<h${level}>${text(heading[2].trim())}</h${level}>`
  return rest.length > 0 ? html + renderBlock(rest.join('\n')) : html
}

export function renderBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(renderBlock)
    .join('\n')
}

function signatureCell(heading: string, organisation: string, party: SigningParty, sign: string, date: string): string {
  return [
    '<td>',
    `<p class="party">${text(heading)}</p>`,
    `<p>${text(organisation)}</p>`,
    `<div class="line"><span class="anchor">${sign}</span></div>`,
    `<p>Name: ${text(party.name)}<br>Title: ${text(party.title)}</p>`,
    `<p>Date: <span class="anchor">${date}</span></p>`,
    '</td>',
  ].join('')
}

export function renderAgreementHtml(input: {
  title: string
  version: number
  body: string
  customer: CustomerFields
  signer: SigningParty
  countersigner: SigningParty
}): string {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${text(input.title)}</title><style>${STYLE}</style></head><body>`,
    `<p class="meta">Version ${input.version}</p>`,
    `<h1 class="title">${text(input.title)}</h1>`,
    renderBody(mergeCustomerFields(input.body, input.customer)),
    '<h1>Signatures</h1>',
    '<p>Each party signs this Agreement electronically and agrees that its electronic signature is as binding as a handwritten one.</p>',
    '<table class="sign"><tr>',
    signatureCell('Signed for the Customer', input.customer.legalName, input.signer, ANCHORS.customerSign, ANCHORS.customerDate),
    signatureCell('Signed for Restiq', 'The Restiq entity named in the applicable Country Schedule', input.countersigner, ANCHORS.platformSign, ANCHORS.platformDate),
    '</tr></table>',
    '</body></html>',
  ].join('\n')
}
