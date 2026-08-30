import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';
import { randomBytes } from 'crypto';

@Controller('credentials')
export class CredentialsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('keys')
  async listKeys(@CurrentUser() user: any) {
    const ctx = extractTenantContext(user);

    // List all channel connections of type 'api' for the tenant
    const rows = await this.prisma.channel_connections.findMany({
      where: {
        company_id: ctx.companyId,
        channel_type: 'api',
      },
      include: {
        painel_clients: {
          select: {
            company_name: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    // O segredo HMAC nunca é retornado em listagens; apenas na criação/rotação
    return rows.map(({ inbound_secret_hash, ...rest }) => ({
      ...rest,
      has_secret: Boolean(inbound_secret_hash),
    }));
  }

  @Post('keys/rotate')
  async rotateKey(
    @CurrentUser() user: any,
    @Body('connection_id', ParseUUIDPipe) connectionId: string,
  ) {
    const ctx = extractTenantContext(user);

    // Verify ownership of the connection
    const connection = await this.prisma.channel_connections.findFirst({
      where: {
        id: connectionId,
        company_id: ctx.companyId,
      },
    });

    if (!connection) {
      throw new NotFoundException('API connection not found');
    }

    const newSecret = 'sk_' + randomBytes(32).toString('hex');

    await this.prisma.channel_connections.update({
      where: { id: connectionId },
      data: {
        inbound_secret_hash: newSecret,
        updated_at: new Date(),
      },
    });

    // Segredo exibido apenas uma vez, na rotação
    return {
      id: connection.id,
      client_id: connection.client_id,
      inbound_secret: newSecret,
    };
  }

  @Post('keys/create-api-connection')
  async createApiConnection(
    @CurrentUser() user: any,
    @Body('client_id', ParseUUIDPipe) clientId: string,
  ) {
    const ctx = extractTenantContext(user);

    // Validate that the client belongs to the user's company
    const client = await this.prisma.painel_clients.findFirst({
      where: {
        id: clientId,
        company_id: ctx.companyId,
      },
    });

    if (!client) {
      throw new UnauthorizedException('Client not found or access denied');
    }

    // Check if an API connection already exists for this client
    const existing = await this.prisma.channel_connections.findFirst({
      where: {
        client_id: clientId,
        channel_type: 'api',
      },
    });

    if (existing) {
      return existing;
    }

    const secret = 'sk_' + randomBytes(32).toString('hex');

    const created = await this.prisma.channel_connections.create({
      data: {
        company_id: ctx.companyId,
        client_id: clientId,
        channel_type: 'api',
        provider: 'custom_api',
        status: 'active',
        inbound_secret_hash: secret,
        config: {},
      },
    });

    // Segredo exibido apenas uma vez, na criação
    return {
      id: created.id,
      client_id: created.client_id,
      channel_type: created.channel_type,
      status: created.status,
      inbound_secret: secret,
    };
  }
}
