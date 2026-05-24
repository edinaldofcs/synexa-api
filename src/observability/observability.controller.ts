import { Controller, Get, Query } from '@nestjs/common';
import { ObservabilityService } from './observability.service';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly observabilityService: ObservabilityService) {}

  @Get('queues')
  getQueues() {
    return this.observabilityService.getQueueMetrics();
  }

  @Get('latency')
  getLatency(@Query('hours') hours?: string) {
    return this.observabilityService.getLatencyMetrics(Number(hours) || 24);
  }

  @Get('cost')
  getCost(@Query('hours') hours?: string) {
    return this.observabilityService.getCostMetrics(Number(hours) || 168);
  }

  @Get('errors')
  getErrors(@Query('hours') hours?: string) {
    return this.observabilityService.getErrorsByTenant(Number(hours) || 24);
  }
}
