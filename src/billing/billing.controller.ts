import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { AuthGuard } from '../common/auth/auth.guard';
import { Tenant } from '../common/auth/tenant.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('summary')
  async getSummary(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('month') month?: string,
  ) {
    const companyId = tenantCompanyId || user?.company_id || user?.companyId || '00000000-0000-0000-0000-000000000001';
    let periodDate: Date | undefined;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, m] = month.split('-').map(Number);
      periodDate = new Date(year, m - 1, 1);
    }

    return this.billingService.getUsageSummary(companyId, periodDate);
  }

  @Get('daily')
  async getDaily(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('days') days?: string,
  ) {
    const companyId = tenantCompanyId || user?.company_id || user?.companyId || '00000000-0000-0000-0000-000000000001';
    const daysCount = days ? parseInt(days, 10) : 30;
    return this.billingService.getDailyUsage(companyId, daysCount);
  }
}
