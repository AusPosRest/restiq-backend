import { describe, expect, it } from 'vitest'
import { ANCHORS, CustomerFields, mergeCustomerFields, renderAgreementHtml, renderBody } from './agreement-document'

const CUSTOMER: CustomerFields = { legalName: 'Bombay Bistro Pty Ltd', address: '1 George St, Sydney NSW 2000', country: 'AU', taxId: 'ABN 12 345 678 901' }
const PARTIES = { signer: { name: 'Asha Rao', title: 'Director' }, countersigner: { name: 'Priya Menon', title: 'Authorised Signatory' } }

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('agreement document', () => {
  it('renders leading heading lines and blank-line paragraphs, keeping single newlines', () => {
    expect(renderBody('# 1. Scope\n1.1 First.\n1.2 Second.\n\n## Notes\n\n\nPlain')).toBe(
      '<h1>1. Scope</h1><p>1.1 First.<br>1.2 Second.</p>\n<h2>Notes</h2>\n<p>Plain</p>',
    )
  })

  it('escapes markup in the title, body and parties', () => {
    const html = renderAgreementHtml({
      title: '<b>Terms</b>',
      version: 3,
      body: '<script>alert(1)</script>',
      customer: { ...CUSTOMER, legalName: '<img src=x onerror=alert(1)>' },
      signer: { name: 'A & B', title: 'Owner' },
      countersigner: PARTIES.countersigner,
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('Version 3')
  })

  it('fills customer fields and leaves unknown placeholders alone', () => {
    expect(mergeCustomerFields('{{customer.legalName}} of {{ customer.address }}, {{customer.country}} ({{customer.taxId}}) {{restiq.entity}}', CUSTOMER)).toBe(
      'Bombay Bistro Pty Ltd of 1 George St, Sydney NSW 2000, Australia (ABN 12 345 678 901) {{restiq.entity}}',
    )
    expect(mergeCustomerFields('{{customer.taxId}} / {{customer.country}}', { ...CUSTOMER, country: 'IN', taxId: null })).toBe('not provided / India')
  })

  it('places each signature anchor exactly once, even if the body tries to add another', () => {
    const html = renderAgreementHtml({ title: 'T', version: 1, body: `Sign here ${ANCHORS.customerSign} ${ANCHORS.platformDate}`, customer: CUSTOMER, ...PARTIES })
    for (const anchor of Object.values(ANCHORS)) expect(count(html, anchor)).toBe(1)
    expect(html).toContain('Name: Asha Rao<br>Title: Director')
    expect(html).toContain('Name: Priya Menon<br>Title: Authorised Signatory')
  })
})
