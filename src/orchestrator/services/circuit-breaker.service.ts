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
  private readonly probeTtlSeconds = 10;
  private readonly inMemoryState = new Map<string, CircuitInfo>();

  constructor(
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  private getCircuitKey(provider: string, clientId?: string): string {
    const p = provider.toLowerCase().trim();
    return clientId ? `circuit:${clientId}:${p}` : `circuit:global:${p}`;
  }

  private getProbeKey(key: string): string {
    return `cb:probe:${key}`;
  }

  async getState(provider: string, clientId?: string): Promise<CircuitInfo> {
    const key = this.getCircuitKey(provider, clientId);

    let cached: CircuitInfo | null = null;
    try {
      cached = await this.redisService.get<CircuitInfo>(key);
    } catch {
      // Fallback para memória em caso de falha transitória do Redis
    }

    const local = this.inMemoryState.get(key);
    let info: CircuitInfo | undefined = cached ?? undefined;
    if (
      local &&
      (!cached || (local.lastFailureTime ?? 0) >= (cached.lastFailureTime ?? 0))
    ) {
      info = local;
    }
    if (!info) {
      info = { state: 'CLOSED', consecutiveFailures: 0 };
    }

    const evaluated = this.evaluateState(info);
    if (evaluated.state !== info.state) {
      // Transição lazy OPEN→HALF_OPEN: persiste somente na mudança de estado
      this.inMemoryState.set(key, evaluated);
      await this.persistState(key, evaluated);
    }

    return evaluated;
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
    const key = this.getCircuitKey(provider, clientId);
    const info = await this.getState(provider, clientId);

    if (info.state === 'CLOSED') return true;
    if (info.state !== 'HALF_OPEN') return false;

    // HALF_OPEN: probe única via SETNX — somente 1 request passa; os demais
    // são rejeitados até a probe concluir (sucesso/falha) ou expirar
    try {
      return await this.redisService.acquireLock(
        this.getProbeKey(key),
        this.probeTtlSeconds,
      );
    } catch {
      return true;
    }
  }

  async recordSuccess(provider: string, clientId?: string): Promise<void> {
    const key = this.getCircuitKey(provider, clientId);
    const current = await this.getState(provider, clientId);
    const updated: CircuitInfo = {
      state: 'CLOSED',
      consecutiveFailures: 0,
    };

    this.inMemoryState.set(key, updated);

    // Persistência (Redis + PG) somente em transição de estado; em CLOSED
    // estável (fluxo normal por turno) nada é escrito
    if (current.state !== 'CLOSED') {
      await this.persistState(key, updated);
      await this.releaseProbe(key);

      if (clientId) {
        void this.updateCredentialHealth(clientId, provider, 'healthy');
      }
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

    this.inMemoryState.set(key, updated);

    // Persistência (Redis + PG) somente na transição de estado
    if (state !== current.state) {
      await this.persistState(key, updated);
      await this.releaseProbe(key);

      if (clientId) {
        const healthStatus = isRateLimit ? 'quota_exceeded' : 'error';
        void this.updateCredentialHealth(clientId, provider, healthStatus);
      }
    }
  }

  private async releaseProbe(key: string): Promise<void> {
    try {
      await this.redisService.del(this.getProbeKey(key));
    } catch {}
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
