import { Controller, Get, Query } from '@nestjs/common';
import { ObservabilityService } from './observability.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly observabilityService: ObservabilityService) {}

  @Get('queues')
  getQueues(@CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.observabilityService.getQueueMetrics(ctx.companyId);
  }

  @Get('latency')
  getLatency(@CurrentUser() user: any, @Query('hours') hours?: string) {
    const ctx = extractTenantContext(user);
    return this.observabilityService.getLatencyMetrics(
      Number(hours) || 24,
      ctx.companyId,
    );
  }

  @Get('cost')
  getCost(@CurrentUser() user: any, @Query('hours') hours?: string) {
    const ctx = extractTenantContext(user);
    return this.observabilityService.getCostMetrics(
      Number(hours) || 168,
      ctx.companyId,
    );
  }

  @Get('errors')
  getErrors(@CurrentUser() user: any, @Query('hours') hours?: string) {
    const ctx = extractTenantContext(user);
    return this.observabilityService.getErrorsByTenant(
      Number(hours) || 24,
      ctx.companyId,
    );
  }
}
