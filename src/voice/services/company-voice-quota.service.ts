import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

// Redis time and one atomic transaction cover all ingress processes and agents.
export const ACQUIRE_VOICE_SLOT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
for i = 1, 2 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 1 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 2 end
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now + 60000, ARGV[1])
  redis.call('PEXPIRE', KEYS[i], 120000)
end
return 0`;

export const RENEW_VOICE_SLOT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
for i = 1, 2 do
  local score = redis.call('ZSCORE', KEYS[i], ARGV[1])
  if not score or tonumber(score) <= now then return 0 end
end
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now + 60000, ARGV[1])
  redis.call('PEXPIRE', KEYS[i], 120000)
end
return 1`;

export interface VoiceSlotLease {
  release(): Promise<void>;
}

@Injectable()
export class CompanyVoiceQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(CompanyVoiceQuotaService.name);
  private readonly client: Redis;
  private readonly leases = new Map<VoiceSlotLease, () => void>();
  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    private readonly config: ConfigService,
  ) {
    // Quota checks must fail promptly instead of queuing commands during an outage.
    this.client = redis.getClient().duplicate({
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on('error', () =>
      this.logger.error('Voice quota Redis unavailable'),
    );
  }

  async acquire(
    companyId: string | undefined,
    onLost: () => void,
  ): Promise<VoiceSlotLease> {
    if (!companyId)
      throw new ServiceUnavailableException(
        'Empresa da chamada não identificada.',
      );
    const company = await this.prisma.companies.findUnique({
      where: { id: companyId },
      select: { status: true, max_concurrent_calls: true },
    });
    if (!company || company.status !== 'active')
      throw new ServiceUnavailableException('Empresa indisponível.');
    const globalLimit = Number(this.config.get('VOICE_MAX_SESSIONS', 50));
    if (!Number.isInteger(globalLimit) || globalLimit < 1)
      throw new ServiceUnavailableException(
        'Capacidade de voz não configurada.',
      );
    const keys = ['voice:{quota}:global', `voice:{quota}:company:${companyId}`];
    const token = randomUUID();
    let result: number;
    try {
      result = Number(
        await this.client.eval(
          ACQUIRE_VOICE_SLOT,
          2,
          ...keys,
          token,
          globalLimit,
          company.max_concurrent_calls,
        ),
      );
    } catch {
      throw new ServiceUnavailableException(
        'Controle de chamadas indisponível. Tente novamente.',
      );
    }
    if (result !== 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice_capacity_rejected',
          company_id: companyId,
          scope: result === 1 ? 'server' : 'company',
        }),
      );
      throw new ServiceUnavailableException(
        result === 1
          ? 'Limite de chamadas simultâneas do servidor atingido.'
          : `Limite de chamadas simultâneas da empresa atingido (máximo: ${company.max_concurrent_calls}).`,
      );
    }
    let released = false;
    let renewing = false;
    let deadline: ReturnType<typeof setTimeout>;
    const lose = () => {
      if (released) return;
      this.logger.error(
        JSON.stringify({
          event: 'voice_capacity_lease_lost',
          company_id: companyId,
        }),
      );
      // Stop media before its reservation can expire and be reused.
      try {
        onLost();
      } catch {
        this.logger.error('Voice capacity shutdown callback failed');
      } finally {
        void lease.release();
      }
    };
    const armDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(lose, 35000);
      deadline.unref?.();
    };
    const interval = setInterval(() => {
      if (released || renewing) return;
      renewing = true;
      void this.client
        .eval(RENEW_VOICE_SLOT, 2, ...keys, token)
        .then((renewed) => {
          if (!released) {
            if (Number(renewed) === 1) armDeadline();
            else lose();
          }
        })
        .catch(lose)
        .finally(() => {
          renewing = false;
        });
    }, 10000);
    interval.unref?.();
    const lease: VoiceSlotLease = {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(interval);
        clearTimeout(deadline);
        this.leases.delete(lease);
        try {
          await this.client.eval(
            "return redis.call('ZREM', KEYS[1], ARGV[1]) + redis.call('ZREM', KEYS[2], ARGV[1])",
            2,
            ...keys,
            token,
          );
        } catch {
          this.logger.warn(
            'Voice quota release failed; reservation expires automatically',
          );
        }
      },
    };
    this.leases.set(lease, onLost);
    armDeadline();
    return lease;
  }

  async onModuleDestroy() {
    const leases = [...this.leases.entries()];
    for (const [, stop] of leases) {
      try {
        stop();
      } catch {
        this.logger.error('Voice shutdown callback failed');
      }
    }
    await Promise.all(leases.map(([lease]) => lease.release()));
    this.client.disconnect();
  }
}
