// CAP-9 reports catalogue. tenantId is never accepted from the request -
// every read is scoped to the signed-in owner's session (AD-5), same
// posture as every other admin DTO.
export type ReportCategory = 'sales' | 'financial' | 'menu' | 'operations' | 'inventory' | 'labour'

export interface ReportCatalogueEntry {
  key: string
  name: string
  category: ReportCategory
  hasData: boolean
  message: string
  exportFormats: string[]
}

export type ExportDestinationStatus = 'not_connected'

export interface ExportDestinationView {
  key: string
  name: string
  status: ExportDestinationStatus
}
