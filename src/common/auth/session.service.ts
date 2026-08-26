import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';

export const SESSION_TTL_SECONDS = 60 * 60 * 24;

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  company_id: string | null;
  company_name?: string | null;
}

export interface AuthSession {
  id: string;
  user: SessionUser;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

@Injectable()
export class SessionService {
  constructor(private readonly redis: RedisService) {}

  async create(user: SessionUser): Promise<AuthSession> {
    const now = Date.now();
    const session: AuthSession = {
      id: randomBytes(32).toString('base64url'),
      user,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_SECONDS * 1000,
    };

    await this.redis.set(this.key(session.id), session, SESSION_TTL_SECONDS);
    await this.redis.addToSet(this.userKey(user.id), session.id);
    await this.redis.expire(this.userKey(user.id), SESSION_TTL_SECONDS);
    return session;
  }

  async get(sessionId: string): Promise<AuthSession | null> {
    const session = await this.redis.get<AuthSession>(this.key(sessionId));
    if (!session || session.expiresAt <= Date.now()) {
      if (session) await this.destroy(sessionId);
      return null;
    }

    const now = Date.now();
    if (now - session.lastSeenAt >= 5 * 60 * 1000) {
      session.lastSeenAt = now;
      const remainingSeconds = Math.max(
        1,
        Math.ceil((session.expiresAt - now) / 1000),
      );
      await this.redis.set(this.key(session.id), session, remainingSeconds);
    }

    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    const session = await this.redis.get<AuthSession>(this.key(sessionId));
    await this.redis.del(this.key(sessionId));
    if (session) {
      await this.redis.removeFromSet(this.userKey(session.user.id), sessionId);
    }
  }

  async destroyAllForUser(userId: string): Promise<void> {
    const sessionIds = await this.redis.getSetMembers(this.userKey(userId));
    await Promise.all(
      sessionIds.map((sessionId) => this.redis.del(this.key(sessionId))),
    );
    await this.redis.del(this.userKey(userId));
  }

  private key(sessionId: string) {
    return `auth:session:${sessionId}`;
  }

  private userKey(userId: string) {
    return `auth:user-sessions:${userId}`;
  }
}
