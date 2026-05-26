import { ApiKeyGuard, REQUIRES_API_KEY } from './api-key.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let reflector: jest.Mocked<Reflector>;
  let prismaService: any;
  let redisService: any;

  function mockContext(body: any, headers: Record<string, string>) {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ body, headers }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    prismaService = {
      channel_connections: {
        findUnique: jest.fn(),
      },
    };

    redisService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    guard = new ApiKeyGuard(prismaService, redisService, reflector);
  });

  describe('when API key is not required', () => {
    it('should return true immediately', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const result = await guard.canActivate(mockContext({}, {}));
      expect(result).toBe(true);
    });

    it('should return true when metadata is undefined', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);

      const result = await guard.canActivate(mockContext({}, {}));
      expect(result).toBe(true);
    });
  });

  describe('missing credentials', () => {
    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
    });

    it('should throw when client_id is missing from body', async () => {
      const ctx = mockContext(
        {},
        { 'x-signature': 'sig', 'x-timestamp': '123' },
      );

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow('invalid_signature');
    });

    it('should throw when x-signature header is missing', async () => {
      const ctx = mockContext(
        { client_id: 'client-1' },
        { 'x-timestamp': '123' },
      );

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when x-timestamp header is missing', async () => {
      const ctx = mockContext(
        { client_id: 'client-1' },
        { 'x-signature': 'sig' },
      );

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when all credentials are missing', async () => {
      const ctx = mockContext({}, {});

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when body is null', async () => {
      const ctx = mockContext(null, {
        'x-signature': 'sig',
        'x-timestamp': '123',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('channel connection validation', () => {
    const validBody = { client_id: 'client-1', origin_channel: 'whatsapp' };
    const nowSec = Math.floor(Date.now() / 1000);

    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
    });

    it('should throw when channel connection is not found', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue(null);

      const ctx = mockContext(validBody, {
        'x-signature': 'sig',
        'x-timestamp': String(nowSec),
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when channel connection has no inbound_secret_hash', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue({});

      const ctx = mockContext(validBody, {
        'x-signature': 'sig',
        'x-timestamp': String(nowSec),
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should default origin_channel to api when not in body', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: 'secret',
      });
      redisService.get.mockResolvedValue(null);
      redisService.set.mockResolvedValue(undefined);

      const body = { client_id: 'client-1' };
      const timestamp = String(nowSec);
      const payload = JSON.stringify(body);
      const expectedSig = createHmac('sha256', 'secret')
        .update(`${timestamp}.${payload}`)
        .digest('hex');

      const ctx = mockContext(body, {
        'x-signature': expectedSig,
        'x-timestamp': timestamp,
      });

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(prismaService.channel_connections.findUnique).toHaveBeenCalledWith(
        {
          where: {
            client_id_channel_type: {
              client_id: 'client-1',
              channel_type: 'api',
            },
          },
        },
      );
    });
  });

  describe('timestamp validation', () => {
    const body = { client_id: 'client-1' };

    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
    });

    it('should throw when timestamp is more than 5 minutes in the past', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: 'secret',
      });
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);

      const ctx = mockContext(body, {
        'x-signature': 'sig',
        'x-timestamp': oldTimestamp,
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when timestamp is more than 5 minutes in the future', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: 'secret',
      });
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 301);

      const ctx = mockContext(body, {
        'x-signature': 'sig',
        'x-timestamp': futureTimestamp,
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should accept timestamp exactly at the 5-minute boundary', async () => {
      const secret = 'secret';
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: secret,
      });
      redisService.get.mockResolvedValue(null);
      redisService.set.mockResolvedValue(undefined);

      const boundaryTimestamp = String(Math.floor(Date.now() / 1000) - 300);
      const payload = JSON.stringify(body);
      const expectedSig = createHmac('sha256', secret)
        .update(`${boundaryTimestamp}.${payload}`)
        .digest('hex');

      const ctx = mockContext(body, {
        'x-signature': expectedSig,
        'x-timestamp': String(boundaryTimestamp),
      });

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  describe('replay detection', () => {
    const body = { client_id: 'client-1' };
    const nowSec = Math.floor(Date.now() / 1000);

    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
    });

    it('should throw when nonce already exists in Redis', async () => {
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: 'secret',
      });
      redisService.get.mockResolvedValue('1');

      const ctx = mockContext(body, {
        'x-signature': 'sig',
        'x-timestamp': String(nowSec),
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should store nonce in Redis on successful validation', async () => {
      const secret = 'secret';
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: secret,
      });
      redisService.get.mockResolvedValue(null);
      redisService.set.mockResolvedValue(undefined);

      const timestamp = String(nowSec);
      const payload = JSON.stringify(body);
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${payload}`)
        .digest('hex');

      const ctx = mockContext(body, {
        'x-signature': signature,
        'x-timestamp': timestamp,
      });

      await guard.canActivate(ctx);

      const expectedReplayKey = `hmac:replay:client-1:${timestamp}:${signature}`;
      expect(redisService.get).toHaveBeenCalledWith(expectedReplayKey);
      expect(redisService.set).toHaveBeenCalledWith(expectedReplayKey, '1');
    });
  });

  describe('signature validation', () => {
    const body = { client_id: 'client-1' };
    const secret = 'inbound-secret-hash-123';
    const nowSec = Math.floor(Date.now() / 1000);

    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
      prismaService.channel_connections.findUnique.mockResolvedValue({
        inbound_secret_hash: secret,
      });
      redisService.get.mockResolvedValue(null);
      redisService.set.mockResolvedValue(undefined);
    });

    it('should throw when signature does not match HMAC', async () => {
      const timestamp = String(nowSec);
      const payload = JSON.stringify(body);

      const correctSig = createHmac('sha256', secret)
        .update(`${timestamp}.${payload}`)
        .digest('hex');
      const wrongSig = createHmac('sha256', 'wrong-secret')
        .update(`${timestamp}.${payload}`)
        .digest('hex');

      const ctx = mockContext(body, {
        'x-signature': wrongSig,
        'x-timestamp': timestamp,
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should return true when signature matches', async () => {
      const timestamp = String(nowSec);
      const payload = JSON.stringify(body);
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${payload}`)
        .digest('hex');

      const ctx = mockContext(body, {
        'x-signature': signature,
        'x-timestamp': timestamp,
      });

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('should throw when signature has wrong length', async () => {
      const ctx = mockContext(body, {
        'x-signature': 'short',
        'x-timestamp': String(nowSec),
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
