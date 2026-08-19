import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

export type OperatorPresenceStatus = 'available' | 'finishing';

@Injectable()
export class OperatorPresenceService {
  private readonly logger = new Logger(OperatorPresenceService.name);
  private readonly PRESENCE_TTL_SECONDS = 35; // Heartbeat a cada 15s no frontend

  constructor(private readonly redisService: RedisService) {}

  async heartbeat(
    userId: string,
    companyId: string,
    status: OperatorPresenceStatus = 'available',
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const presenceKey = `operator:presence:${companyId}:${userId}`;
    const lastSeenKey = `operator:last_seen:${userId}`;
    const now = Date.now().toString();

    // Se a chave já existir e nenhum status novo for passado, preserva o status atual
    const existing = await redis.get(presenceKey);
    let finalStatus = status;
    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        if (parsed.status && !status) {
          finalStatus = parsed.status;
        }
      } catch {}
    }

    const payload = JSON.stringify({ status: finalStatus, last_seen: now });

    await redis
      .pipeline()
      .set(presenceKey, payload, 'EX', this.PRESENCE_TTL_SECONDS)
      .set(lastSeenKey, now)
      .exec();

    this.logger.debug(
      `Heartbeat recebido para operador ${userId} (${finalStatus}) da empresa ${companyId}`,
    );
  }

  async setStatus(
    userId: string,
    companyId: string,
    status: OperatorPresenceStatus,
  ): Promise<void> {
    await this.heartbeat(userId, companyId, status);
    this.logger.log(`Operador ${userId} alterou status para: ${status}`);
  }

  async setOffline(userId: string, companyId: string): Promise<void> {
    const redis = this.redisService.getClient();
    const presenceKey = `operator:presence:${companyId}:${userId}`;
    await redis.del(presenceKey);
    this.logger.log(`Operador ${userId} desconectou-se manualmente`);
  }

  async isOnline(userId: string, companyId: string): Promise<boolean> {
    const redis = this.redisService.getClient();
    const presenceKey = `operator:presence:${companyId}:${userId}`;
    const exists = await redis.exists(presenceKey);
    return exists === 1;
  }

  async listOnline(companyId: string): Promise<string[]> {
    const redis = this.redisService.getClient();
    const pattern = `operator:presence:${companyId}:*`;
    const keys = await redis.keys(pattern);
    const prefix = `operator:presence:${companyId}:`;

    return keys.map((key) => key.replace(prefix, ''));
  }

  /**
   * Retorna apenas os operadores DISPONÍVEIS para receber novos transbordos automáticos
   */
  async listAvailable(companyId: string): Promise<string[]> {
    const redis = this.redisService.getClient();
    const pattern = `operator:presence:${companyId}:*`;
    const keys = await redis.keys(pattern);
    const prefix = `operator:presence:${companyId}:`;
    if (!keys || keys.length === 0) return [];

    const values = await redis.mget(keys);
    const availableIds: string[] = [];

    keys.forEach((key, index) => {
      const val = values[index];
      const userId = key.replace(prefix, '');
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.status === 'available' || !parsed.status) {
            availableIds.push(userId);
          }
        } catch {
          availableIds.push(userId);
        }
      }
    });

    return availableIds;
  }

  async listOnlineWithStatus(
    companyId: string,
  ): Promise<Map<string, OperatorPresenceStatus>> {
    const redis = this.redisService.getClient();
    const pattern = `operator:presence:${companyId}:*`;
    const keys = await redis.keys(pattern);
    const prefix = `operator:presence:${companyId}:`;
    const map = new Map<string, OperatorPresenceStatus>();
    if (!keys || keys.length === 0) return map;

    const values = await redis.mget(keys);
    keys.forEach((key, index) => {
      const val = values[index];
      const userId = key.replace(prefix, '');
      let status: OperatorPresenceStatus = 'available';
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.status) status = parsed.status;
        } catch {}
      }
      map.set(userId, status);
    });

    return map;
  }

  async getLastSeen(userId: string): Promise<number | null> {
    const redis = this.redisService.getClient();
    const lastSeenKey = `operator:last_seen:${userId}`;
    const raw = await redis.get(lastSeenKey);
    return raw ? parseInt(raw, 10) : null;
  }
}
