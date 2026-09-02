import { Controller, Get, Header, Query } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { ExportDestinationView, ListPaymentsQueryDto, PaymentsFilterDto, PaymentsListResult, ReportCatalogueEntry } from './reports.dtos'
import { ReportsService } from './reports.service'

@Controller('admin/v1/reports')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  catalogue(): ReportCatalogueEntry[] {
    return this.reports.catalogue()
  }

  @Get('export-destinations')
  exportDestinations(): ExportDestinationView[] {
    return this.reports.exportDestinations()
  }

  @Get('payments')
  listPayments(@CurrentOwner() owner: AdminPrincipal, @Query() query: ListPaymentsQueryDto): Promise<PaymentsListResult> {
    return this.reports.listPayments(owner, query)
  }

  @Get('payments/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="payments.csv"')
  exportPayments(@CurrentOwner() owner: AdminPrincipal, @Query() query: PaymentsFilterDto): Promise<string> {
    return this.reports.exportPaymentsCsv(owner, query)
  }

  @Get('menu-catalogue/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="menu-catalogue.csv"')
  exportMenuCatalogue(@CurrentOwner() owner: AdminPrincipal, @Query('format') format: string): Promise<string> {
    return this.reports.exportMenuCatalogueCsv(owner, format)
  }

  @Get('staff-roster/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="staff-roster.csv"')
  exportStaffRoster(@CurrentOwner() owner: AdminPrincipal, @Query('format') format: string): Promise<string> {
    return this.reports.exportStaffRosterCsv(owner, format)
  }
}
