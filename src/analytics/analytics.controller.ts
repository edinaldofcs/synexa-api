import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsConfigDto } from './dto/analytics.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('business')
  async business(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('client_id') clientId?: string,
    @Query('channel') channel?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.analyticsService.getBusinessAnalytics(ctx.companyId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      clientId: clientId || undefined,
      channel: channel || undefined,
    });
  }

  @Get('bi-dashboard')
  async biDashboard(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('channel') channel?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.analyticsService.getBiDashboard(ctx.companyId, {
      clientId: clientId || undefined,
      channel: channel || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('interactions-report')
  async interactionsReport(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('disposition') disposition?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.analyticsService.getInteractionsReport(ctx.companyId, {
      clientId: clientId || undefined,
      channel: channel || undefined,
      status: status || undefined,
      disposition: disposition || undefined,
      search: search || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 25,
    });
  }

  @Get('consumption-costs')
  async consumptionCosts(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.analyticsService.getCostsAndConsumption(ctx.companyId, {
      clientId: clientId || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('config')
  async getConfig(
    @CurrentUser() user: any,
    @Query('client_id') clientId: string,
  ) {
    const ctx = extractTenantContext(user);
    void ctx;
    return this.analyticsService.getConfig(clientId);
  }

  @Put('config')
  async saveConfig(
    @CurrentUser() user: any,
    @Query('client_id') clientId: string,
    @Body() config: AnalyticsConfigDto,
  ) {
    const ctx = extractTenantContext(user);
    return this.analyticsService.saveConfig(clientId, ctx.companyId, config);
  }
}
