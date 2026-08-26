import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;
  private readonly sessionTtl = 60 * 60 * 24;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
    this.client = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.client.on('connect', () => this.logger.log('Conectado ao Redis'));
    this.client.on('error', (err) =>
      this.logger.error(`Redis: ${err.message}`),
    );
  }

  async set(
    key: string,
    value: unknown,
    ttlSeconds: number = this.sessionTtl,
  ): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    return data ? (JSON.parse(data) as T) : null;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async addToSet(key: string, value: string): Promise<void> {
    await this.client.sadd(key, value);
  }

  async getSetMembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async removeFromSet(key: string, value: string): Promise<void> {
    await this.client.srem(key, value);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async checkRateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const now = Date.now();
    const windowKey = `ratelimit:${key}:${Math.floor(now / (windowSeconds * 1000))}`;

    const current = await this.client.incr(windowKey);
    if (current === 1) {
      await this.client.expire(windowKey, windowSeconds);
    }

    const ttl = await this.client.ttl(windowKey);
    const allowed = current <= maxRequests;
    const remaining = Math.max(0, maxRequests - current);
    const resetAt = new Date(now + ttl * 1000);

    return { allowed, remaining, resetAt };
  }

  async acquireLock(key: string, ttlSeconds: number = 30): Promise<boolean> {
    const result = await this.client.set(
      key,
      'locked',
      'PX',
      ttlSeconds * 1000,
      'NX',
    );
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.client.del(key);
  }

  async rpush(key: string, value: unknown): Promise<void> {
    await this.client.rpush(key, JSON.stringify(value));
    await this.client.expire(key, this.sessionTtl);
  }

  async lrange<T = unknown>(key: string): Promise<T[]> {
    const items = await this.client.lrange(key, 0, -1);
    return items.map((m) => JSON.parse(m) as T);
  }

  getClient(): Redis {
    return this.client;
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }

  onModuleDestroy() {
    this.quit();
  }
}
