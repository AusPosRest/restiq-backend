// Agreement payloads (issues #132, #150). Publishing carries a required
// reason (AD-6). Signing happens in DocuSign; starting it carries the
// signer's full name and title, which go into the signature block of the
// document DocuSign seals.
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator'

export class PublishAgreementDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title!: string

  @IsString() @IsNotEmpty() @MaxLength(200_000)
  body!: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class StartSigningDto {
  // Full legal name as it appears in the signature block - blanks are not a name.
  @IsString() @Matches(/\S/, { message: 'signerName must not be blank' }) @MaxLength(200)
  signerName!: string

  // Role at the business (Director, Owner, ...): evidence of authority to sign for it.
  @IsString() @Matches(/\S/, { message: 'signerTitle must not be blank' }) @MaxLength(120)
  signerTitle!: string
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
  /** Null on the typed-name signatures from before DocuSign (#132). */
  signerTitle: string | null
  signedAt: string
  /** SHA-256 of the sealed PDF for DocuSign signatures; of the signing record for earlier ones. */
  evidenceSha256: string
  /** A sealed, signed PDF (with DocuSign's Certificate of Completion) can be downloaded. */
  hasPdf: boolean
}

export type TenantAgreementStatus = 'signed' | 'awaiting_countersign' | 'pending' | 'no_agreement'

/** Ops: one tenant's standing against the current version. */
export interface TenantAgreementsView {
  current: Omit<AgreementVersionSummary, 'signatureCount'> | null
  status: TenantAgreementStatus
  signatures: AgreementSignatureView[]
}

/** A DocuSign signing in progress on the current version. */
export interface OwnerSigningView {
  status: 'awaiting_owner' | 'awaiting_countersign'
  signerName: string
  signerTitle: string
  ownerSignedAt: string | null
}

/** Admin: the current text (customer fields filled), its signature or signing in progress, and everything signed before. */
export interface OwnerAgreementView {
  current: { id: string; version: number; title: string; body: string; publishedAt: string } | null
  signature: AgreementSignatureView | null
  signing: OwnerSigningView | null
  history: AgreementSignatureView[]
}
