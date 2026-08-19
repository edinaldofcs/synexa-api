import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitInfo {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime?: number;
  nextAttemptTime?: number;
}

@Injectable()
export class ProviderCircuitBreakerService {
  private readonly logger = new Logger(ProviderCircuitBreakerService.name);
  private readonly failureThreshold = 3;
  private readonly cooldownPeriodMs = 60_000; // 60 segundos
  private readonly inMemoryState = new Map<string, CircuitInfo>();

  constructor(
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  private getCircuitKey(provider: string, clientId?: string): string {
    const p = provider.toLowerCase().trim();
    return clientId ? `circuit:${clientId}:${p}` : `circuit:global:${p}`;
  }

  async getState(provider: string, clientId?: string): Promise<CircuitInfo> {
    const key = this.getCircuitKey(provider, clientId);

    try {
      const cached = await this.redisService.get<CircuitInfo>(key);
      if (cached) {
        return this.evaluateState(cached);
      }
    } catch {
      // Fallback para memória em caso de falha transitória do Redis
    }

    const local = this.inMemoryState.get(key) || {
      state: 'CLOSED',
      consecutiveFailures: 0,
    };
    return this.evaluateState(local);
  }

  private evaluateState(info: CircuitInfo): CircuitInfo {
    const now = Date.now();

    if (info.state === 'OPEN') {
      if (info.nextAttemptTime && now >= info.nextAttemptTime) {
        return {
          ...info,
          state: 'HALF_OPEN',
        };
      }
    }

    return info;
  }

  async canExecute(provider: string, clientId?: string): Promise<boolean> {
    const info = await this.getState(provider, clientId);
    return info.state === 'CLOSED' || info.state === 'HALF_OPEN';
  }

  async recordSuccess(provider: string, clientId?: string): Promise<void> {
    const key = this.getCircuitKey(provider, clientId);
    const updated: CircuitInfo = {
      state: 'CLOSED',
      consecutiveFailures: 0,
    };

    await this.persistState(key, updated);
    this.inMemoryState.set(key, updated);

    // Atualiza status de saúde para healthy no banco
    if (clientId) {
      void this.updateCredentialHealth(clientId, provider, 'healthy');
    }
  }

  async recordFailure(
    provider: string,
    error: unknown,
    clientId?: string,
  ): Promise<void> {
    const current = await this.getState(provider, clientId);
    const key = this.getCircuitKey(provider, clientId);
    const now = Date.now();
    const consecutive = current.consecutiveFailures + 1;

    const errMessage = error instanceof Error ? error.message : String(error);
    const isRateLimit = /429|rate limit|quota/i.test(errMessage);

    let state: CircuitState = current.state;
    let nextAttemptTime = current.nextAttemptTime;

    // Se atingir o threshold ou for rate limit severo -> abre o circuito
    if (consecutive >= this.failureThreshold || isRateLimit) {
      state = 'OPEN';
      nextAttemptTime = now + this.cooldownPeriodMs;
      this.logger.warn(
        {
          provider,
          clientId,
          consecutive,
          nextAttemptInMs: this.cooldownPeriodMs,
        },
        'Circuit breaker ABERTO para o provedor',
      );
    }

    const updated: CircuitInfo = {
      state,
      consecutiveFailures: consecutive,
      lastFailureTime: now,
      nextAttemptTime,
    };

    await this.persistState(key, updated);
    this.inMemoryState.set(key, updated);

    if (clientId) {
      const healthStatus = isRateLimit ? 'quota_exceeded' : 'error';
      void this.updateCredentialHealth(clientId, provider, healthStatus);
    }
  }

  private async persistState(key: string, info: CircuitInfo): Promise<void> {
    try {
      await this.redisService.set(key, info);
    } catch {}
  }

  private async updateCredentialHealth(
    clientId: string,
    provider: string,
    status: string,
  ): Promise<void> {
    try {
      await this.prisma.provider_credentials.updateMany({
        where: {
          client_id: clientId,
          provider: provider.toLowerCase().trim(),
        },
        data: {
          health_status: status,
          last_tested_at: new Date(),
        },
      });
    } catch {}
  }
}
