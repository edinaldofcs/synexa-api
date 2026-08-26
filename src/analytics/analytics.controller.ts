import {
  Body,
  Controller,
  Get,
  Put,
  Query,
} from '@nestjs/common';
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

  @Get('config')
  async getConfig(@CurrentUser() user: any, @Query('client_id') clientId: string) {
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
