import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { UUID_SHAPE_REGEX } from '../common/validators/uuid-shape';
import { Tenant } from '../common/auth/tenant.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';

// Protegido pelo AuthGuard global (APP_GUARD); sessão via cookie HttpOnly.
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('summary')
  async getSummary(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('month') month?: string,
    @Query('client_id') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
    const filters = await this.resolveClientFilter(companyId, clientId);
    let periodDate: Date | undefined;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, m] = month.split('-').map(Number);
      periodDate = new Date(year, m - 1, 1);
    }

    return this.billingService.getUsageSummary(companyId, periodDate, {
      ...filters,
      from,
      to,
    });
  }

  @Get('daily')
  async getDaily(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('days') days?: string,
    @Query('client_id') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
    const filters = await this.resolveClientFilter(companyId, clientId);
    const daysCount = days ? this.parseIntParam('days', days) : 30;
    return this.billingService.getDailyUsage(companyId, daysCount, {
      ...filters,
      from,
      to,
    });
  }

  @Get('voice-minutes')
  async getVoiceMinutes(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('client_id') clientId?: string,
    @Query('days') days?: string,
  ) {
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
    const filters = await this.resolveClientFilter(companyId, clientId);
    const daysCount = days ? this.parseIntParam('days', days) : undefined;
    return this.billingService.getVoiceMinutes(companyId, {
      ...filters,
      from,
      to,
      days: daysCount,
    });
  }

  @Get('tokens')
  async getTokens(
    @Tenant('companyId') tenantCompanyId: string,
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('client_id') clientId?: string,
  ) {
    const companyId = this.resolveCompanyId(tenantCompanyId, user);
    const filters = await this.resolveClientFilter(companyId, clientId);
    return this.billingService.getTokensUsage(companyId, {
      ...filters,
      from,
      to,
    });
  }

  private resolveCompanyId(tenantCompanyId: string, user: any): string {
    const companyId = tenantCompanyId || user?.company_id || user?.companyId;
    if (!companyId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return companyId;
  }

  private async resolveClientFilter(
    companyId: string,
    clientId?: string,
  ): Promise<{ clientId?: string }> {
    if (!clientId) return {};
    if (!UUID_SHAPE_REGEX.test(clientId)) {
      throw new BadRequestException(
        "Parâmetro 'client_id' deve ser um UUID válido",
      );
    }
    const client = await this.prisma.painel_clients.findFirst({
      where: { id: clientId, company_id: companyId },
      select: { id: true },
    });
    if (!client) {
      throw new NotFoundException('Cliente não encontrado para esta empresa');
    }
    return { clientId };
  }

  private parseIntParam(name: string, value: string): number {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new BadRequestException(`Parâmetro '${name}' deve ser um número`);
    }
    return parsed;
  }
}
