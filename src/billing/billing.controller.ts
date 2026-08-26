import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { BillingService } from './billing.service';
import { Tenant } from '../common/auth/tenant.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';

// Protegido pelo AuthGuard global (APP_GUARD); sessão via cookie HttpOnly.
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('summary')
  async getSummary(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('month') month?: string,
  ) {
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
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
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
    const daysCount = days ? parseInt(days, 10) : 30;
    return this.billingService.getDailyUsage(companyId, daysCount);
  }

  private resolveCompanyId(tenantCompanyId: string, user: any): string {
    const companyId = tenantCompanyId || user?.company_id || user?.companyId;
    if (!companyId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return companyId;
  }
}
