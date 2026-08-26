import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class WorkerHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHealthService.name);
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    void this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 10_000);
    this.heartbeatTimer.unref();
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async publishHeartbeat() {
    const role = this.configService.get<string>('SERVICE_ROLE', 'worker');
    const key = `runtime:worker:${role}:${process.pid}:heartbeat`;

    try {
      await this.redisService.set(
        key,
        {
          role,
          pid: process.pid,
          started_at: new Date(
            Date.now() - process.uptime() * 1000,
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        30,
      );
    } catch (error: any) {
      this.logger.warn(
        `Worker heartbeat unavailable: ${error?.message || error}`,
      );
    }
  }
}
