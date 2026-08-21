import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get('liveness')
  liveness() {
    return this.healthService.checkLiveness();
  }

  @Public()
  @Get('readiness')
  async readiness(@Res() res: Response) {
    const result = await this.healthService.checkReadiness();
    const statusCode =
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    return res.status(statusCode).json(result);
  }

  @Public()
  @Get()
  async defaultHealth(@Res() res: Response) {
    const result = await this.healthService.checkReadiness();
    const statusCode =
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    return res.status(statusCode).json(result);
  }
}
