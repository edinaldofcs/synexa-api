import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TablesService } from './tables.service';
import { Tenant } from '../common/auth/tenant.decorator';

@Controller('export') // /api/export
export class ExportController {
  constructor(private readonly tablesService: TablesService) {}

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get(':tableName') // /api/export/:tableName
  async exportTable(
    @Param('tableName') tableName: string,
    @Query() params: { startDate?: string; endDate?: string },
    @Tenant('companyId') tenantCompanyId: string,
  ) {
    return this.tablesService.exportTable(tableName, params, tenantCompanyId);
  }
}
