// Agreement payloads (issue #132, PDF rework #179). An agreement is an uploaded PDF the owner
// reads in a viewer. Publishing carries a required reason (AD-6) and the file (multipart);
// signing carries the typed name that IS the signature, an explicit accepted:true so a bare
// POST can never sign, and the hash of the file the owner was shown.
export const MAX_AGREEMENT_PDF_BYTES = 5 * 1024 * 1024

import { Equals, IsBoolean, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator'

export class PublishAgreementDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title!: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class SignAgreementDto {
  // The typed name is the signature - blanks are not a name.
  @IsString() @Matches(/\S/, { message: 'signerName must not be blank' }) @MaxLength(200)
  signerName!: string

  @IsBoolean() @Equals(true)
  accepted!: boolean

  // The file the owner was shown. A different current file means they must read it again.
  @IsString() @Matches(/^[0-9a-f]{64}$/, { message: 'fileSha256 must be the 64-character hash of the agreement file' })
  fileSha256!: string
}

export interface AgreementVersionSummary {
  id: string
  version: number
  title: string
  /** False for a version published as text before the PDF rework: it cannot be read as a file or signed. */
  hasFile: boolean
  fileName: string | null
  sizeBytes: number | null
  fileSha256: string
  publishedBy: string
  publishedAt: string
  signatureCount: number
}

export type AgreementVersionView = AgreementVersionSummary

export interface AgreementSignatureView {
  agreementVersionId: string
  version: number
  title: string
  signerName: string
  signerEmail: string
  signedAt: string
  evidenceSha256: string
}

export type TenantAgreementStatus = 'signed' | 'pending' | 'no_agreement'

/** Ops: one tenant's standing against the current version. */
export interface TenantAgreementsView {
  current: Omit<AgreementVersionSummary, 'signatureCount'> | null
  status: TenantAgreementStatus
  signatures: AgreementSignatureView[]
}

/** Admin: what the owner sees - the current agreement (read the file at .../agreement/:id/file), their signature on it (if any), and everything they signed before. */
export interface OwnerAgreementView {
  current: Omit<AgreementVersionSummary, 'signatureCount' | 'publishedBy'> | null
  signature: AgreementSignatureView | null
  history: AgreementSignatureView[]
}
