// Agreement payloads (issue #132). Publishing carries a required reason
// (AD-6); signing carries the typed name that IS the signature plus an
// explicit accepted:true so a bare POST can never sign.
import { Equals, IsBoolean, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator'

export class PublishAgreementDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title!: string

  @IsString() @IsNotEmpty() @MaxLength(200_000)
  body!: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class SignAgreementDto {
  // The typed name is the signature - blanks are not a name.
  @IsString() @Matches(/\S/, { message: 'signerName must not be blank' }) @MaxLength(200)
  signerName!: string

  @IsBoolean() @Equals(true)
  accepted!: boolean
}

export interface AgreementVersionSummary {
  id: string
  version: number
  title: string
  publishedBy: string
  publishedAt: string
  signatureCount: number
}

export interface AgreementVersionView extends AgreementVersionSummary {
  body: string
  bodySha256: string
}

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

/** Admin: what the owner sees - the full current text, their signature on it (if any), and everything they signed before. */
export interface OwnerAgreementView {
  current: { id: string; version: number; title: string; body: string; publishedAt: string } | null
  signature: AgreementSignatureView | null
  history: AgreementSignatureView[]
}
