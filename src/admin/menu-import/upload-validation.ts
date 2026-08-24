// Trust-boundary check on an uploaded file, before any parsing touches it.
// The declared extension picks the candidate source type; a magic-byte check
// against the actual bytes confirms it (a client-controlled filename and
// mimetype are otherwise the only signal, and are trivial to fake).
import { BadRequestException } from '@nestjs/common'
import type { MenuImportSourceType } from './extraction'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const EXTENSION_SOURCE: Record<string, MenuImportSourceType> = {
  csv: 'csv',
  xlsx: 'xlsx',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  pdf: 'pdf',
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

function matchesMagicBytes(sourceType: MenuImportSourceType, buffer: Buffer): boolean {
  if (sourceType === 'pdf') return buffer.subarray(0, 4).toString('latin1') === '%PDF'
  if (sourceType === 'xlsx') return buffer.subarray(0, 2).toString('latin1') === 'PK' // zip signature
  if (sourceType === 'image') {
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
    const isPng = buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    return isJpeg || isPng
  }
  return buffer.length > 0 // csv: plain text, no magic bytes to check
}

export function resolveSourceType(file: { originalname: string; buffer: Buffer; size: number }): MenuImportSourceType {
  if (file.size === 0) {
    throw new BadRequestException({ code: 'validation_failed', message: 'The uploaded file is empty' })
  }
  const sourceType = EXTENSION_SOURCE[extensionOf(file.originalname)]
  if (!sourceType || !matchesMagicBytes(sourceType, file.buffer)) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'Unsupported file - upload a .csv, .xlsx, .jpg, .png, or .pdf menu file',
    })
  }
  return sourceType
}
