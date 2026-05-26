import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const REQUIRES_API_KEY = 'requires_api_key';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresApiKey = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_API_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresApiKey) return true;

    const request = context.switchToHttp().getRequest();
    const clientId = request.body?.client_id;
    const signature = request.headers['x-signature'];
    const timestamp = request.headers['x-timestamp'];

    if (!clientId || !signature || !timestamp) {
      throw new UnauthorizedException('invalid_signature');
    }

    const connection = await this.prisma.channel_connections.findUnique({
      where: {
        client_id_channel_type: {
          client_id: clientId,
          channel_type: request.body?.origin_channel || 'api',
        },
      },
    });

    if (!connection?.inbound_secret_hash) {
      throw new UnauthorizedException('invalid_signature');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const requestSec = parseInt(timestamp as string, 10);
    if (Math.abs(nowSec - requestSec) > 300) {
      throw new UnauthorizedException('invalid_signature');
    }

    const replayKey = `hmac:replay:${clientId}:${timestamp}:${signature}`;
    const exists = await this.redisService.get(replayKey);
    if (exists) {
      throw new UnauthorizedException('invalid_signature');
    }
    await this.redisService.set(replayKey, '1');

    const payload = JSON.stringify(request.body);
    const expectedSig = createHmac('sha256', connection.inbound_secret_hash)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    try {
      const expected = Buffer.from(expectedSig);
      const received = Buffer.from(signature);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        throw new UnauthorizedException('invalid_signature');
      }
    } catch {
      throw new UnauthorizedException('invalid_signature');
    }

    return true;
  }
}
