import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface HealthCheckResult {
  status: 'ok' | 'error' | 'degraded';
  timestamp: string;
  uptime: number;
  service_role: string;
  environment: string;
  details?: {
    database: { status: 'up' | 'down'; latency_ms?: number; error?: string };
    redis: { status: 'up' | 'down'; latency_ms?: number; error?: string };
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  checkLiveness(): HealthCheckResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      service_role: this.configService.get<string>('SERVICE_ROLE', 'api'),
      environment: this.configService.get<string>('ENVIRONMENT', 'development'),
    };
  }

  async checkReadiness(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    let dbStatus: 'up' | 'down' = 'down';
    let dbLatency = 0;
    let dbError: string | undefined;

    try {
      const dbStart = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      dbLatency = Date.now() - dbStart;
      dbStatus = 'up';
    } catch (err: any) {
      dbError = err?.message || 'Database query failed';
      this.logger.warn(`Readiness DB check failed: ${dbError}`);
    }

    let redisStatus: 'up' | 'down' = 'down';
    let redisLatency = 0;
    let redisError: string | undefined;

    try {
      const redisStart = Date.now();
      const pong = await this.redisService.getClient().ping();
      redisLatency = Date.now() - redisStart;
      redisStatus = pong === 'PONG' ? 'up' : 'down';
    } catch (err: any) {
      redisError = err?.message || 'Redis ping failed';
      this.logger.warn(`Readiness Redis check failed: ${redisError}`);
    }

    const isHealthy = dbStatus === 'up' && redisStatus === 'up';

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      service_role: this.configService.get<string>('SERVICE_ROLE', 'api'),
      environment: this.configService.get<string>('ENVIRONMENT', 'development'),
      details: {
        database: {
          status: dbStatus,
          latency_ms: dbLatency,
          ...(dbError ? { error: dbError } : {}),
        },
        redis: {
          status: redisStatus,
          latency_ms: redisLatency,
          ...(redisError ? { error: redisError } : {}),
        },
      },
    };
  }
}
