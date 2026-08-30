import { HttpException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService, DUMMY_PASSWORD_HASH } from './auth.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn().mockResolvedValue(false),
}));

const compareMock = bcrypt.compare as unknown as jest.Mock;

describe('AuthService - hardening de login (S13/S27/S37)', () => {
  const redis = {
    checkRateLimit: jest.fn(),
  };
  const configService = {
    get: jest.fn(
      (key: string) => (key === 'ENVIRONMENT' ? 'development' : undefined),
    ),
  };
  const prisma = {
    users: { findUnique: jest.fn() },
  };

  const buildService = () =>
    new AuthService(
      prisma as never,
      configService as never,
      redis as never,
      {} as never,
      {} as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    compareMock.mockResolvedValue(false);
    redis.checkRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 1,
      resetAt: new Date(),
    });
    prisma.users.findUnique.mockResolvedValue(null);
  });

  it('S13: limita login por chave composta IP+email e por IP', async () => {
    const service = buildService();

    await expect(
      service.login(' User@Example.com ', 'password', '10.0.0.1'),
    ).rejects.toThrow('Credenciais');

    expect(redis.checkRateLimit).toHaveBeenCalledWith(
      'auth:login:ip:10.0.0.1',
      20,
      60,
    );
    expect(redis.checkRateLimit).toHaveBeenCalledWith(
      'auth:login:10.0.0.1:user@example.com',
      5,
      60,
    );
  });

  it('S13: excedido o teto por IP, bloqueia sem consumir a chave IP+email', async () => {
    redis.checkRateLimit.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('auth:login:ip:'),
      remaining: 0,
      resetAt: new Date(),
    }));
    const service = buildService();

    await expect(
      service.login('user@example.com', 'password', '10.0.0.1'),
    ).rejects.toThrow(HttpException);

    expect(redis.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('S13: excedido o limite IP+email, bloqueia', async () => {
    redis.checkRateLimit.mockImplementation(async (key: string) => ({
      allowed: key.startsWith('auth:login:ip:'),
      remaining: 0,
      resetAt: new Date(),
    }));
    const service = buildService();

    await expect(
      service.login('user@example.com', 'password', '10.0.0.1'),
    ).rejects.toThrow(HttpException);
  });

  it('S27: usuario inexistente executa bcrypt.compare com hash dummy (timing igualado)', async () => {
    const service = buildService();

    await expect(
      service.login('ghost@example.com', 'whatever', '10.0.0.2'),
    ).rejects.toThrow('Credenciais');

    expect(compareMock).toHaveBeenCalledWith('whatever', DUMMY_PASSWORD_HASH);
  });

  it('S37: requestPasswordReset aplica rate limit por email (3/300s)', async () => {
    redis.checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });
    const service = buildService();

    await expect(
      service.requestPasswordReset(
        'user@example.com',
        'http://localhost/reset-password',
      ),
    ).rejects.toThrow(HttpException);

    expect(redis.checkRateLimit).toHaveBeenCalledWith(
      'auth:forgot:email:user@example.com',
      3,
      300,
    );
  });
});
