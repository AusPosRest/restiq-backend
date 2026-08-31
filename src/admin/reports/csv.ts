// Minimal RFC4180-style CSV writer - the one format this module's exports
// produce (see reports.service.ts). No parsing needed here, unlike
// menu-import/extraction.ts's parseCsv - this only ever writes.
function escapeField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(escapeField).join(',')).join('\r\n') + '\r\n'
}
