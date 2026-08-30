import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { AnalyticsConfigDto } from './dto/analytics.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  private resolveTimeWindow(
    from?: string,
    to?: string,
  ): { from: Date; to: Date } {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      fromDate >= toDate
    ) {
      throw new BadRequestException(
        "Parâmetro 'from' deve ser uma data válida anterior a 'to'",
      );
    }
    const maxToDate = new Date(fromDate.getTime() + 90 * 24 * 60 * 60 * 1000);
    return { from: fromDate, to: toDate > maxToDate ? maxToDate : toDate };
  }

  @Get('business')
  async business(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('client_id') clientId?: string,
    @Query('channel') channel?: string,
  ) {
    const ctx = extractTenantContext(user);
    const timeWindow = this.resolveTimeWindow(from, to);
    return this.analyticsService.getBusinessAnalytics(ctx.companyId, {
      from: timeWindow.from,
      to: timeWindow.to,
      clientId: clientId || undefined,
      channel: channel || undefined,
    });
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('bi-dashboard')
  async biDashboard(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('channel') channel?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = extractTenantContext(user);
    const timeWindow = this.resolveTimeWindow(from, to);
    return this.analyticsService.getBiDashboard(ctx.companyId, {
      clientId: clientId || undefined,
      channel: channel || undefined,
      from: timeWindow.from,
      to: timeWindow.to,
    });
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
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
      limit: limit ? Math.min(Number(limit), 1000) : 25,
    });
  }

  @Get('interactions/:id')
  async interactionDetail(@CurrentUser() user: any, @Param('id') id: string) {
    const ctx = extractTenantContext(user);
    const item = await this.analyticsService.getInteractionDetail(
      ctx.companyId,
      id,
    );
    if (!item) throw new NotFoundException('Interação não encontrada');
    return item;
  }

  @Get('interactions-messages')
  async interactionsMessages(
    @CurrentUser() user: any,
    @Query('ids') ids?: string,
  ) {
    const ctx = extractTenantContext(user);
    const idList = (ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.analyticsService.getInteractionsMessages(ctx.companyId, idList);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('consumption-costs')
  async consumptionCosts(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = extractTenantContext(user);
    const timeWindow = this.resolveTimeWindow(from, to);
    return this.analyticsService.getCostsAndConsumption(ctx.companyId, {
      clientId: clientId || undefined,
      from: timeWindow.from,
      to: timeWindow.to,
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
