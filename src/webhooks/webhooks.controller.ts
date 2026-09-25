import { validateWebhookUrl } from '../common/utils/ssrf-guard';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from './dto/create-webhook-endpoint.dto';
import { randomBytes } from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('endpoints')
  async listEndpoints(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');
    return this.prisma.webhook_endpoints.findMany({
      where: {
        ...(clientId ? { client_id: clientId } : {}),
        painel_clients: {
          company_id: ctx.companyId,
        },
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
  }

  @Post('endpoints')
  async createEndpoint(
    @CurrentUser() user: any,
    @Body() body: CreateWebhookEndpointDto,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');

    // Validate that the client belongs to the user's company
    const client = await this.prisma.painel_clients.findFirst({
      where: {
        id: body.client_id,
        company_id: ctx.companyId,
      },
    });

    if (!client) {
      throw new UnauthorizedException('Client not found or access denied');
    }

    await this.validateExportEndpoint(
      body.url,
      body.events,
      body.client_id,
      body.enabled ?? true,
    );
    const secretHash = 'whsec_' + randomBytes(24).toString('hex');

    return this.prisma.webhook_endpoints
      .create({
        data: {
          client_id: body.client_id,
          url: body.url,
          events: body.events,
          secret_hash: secretHash,
          enabled: body.enabled ?? true,
          retry_policy: {
            max_retries: 3,
            retention_hours: body.retention_hours ?? 24,
            include_transcript: body.include_transcript ?? false,
          },
        },
      })
      .catch((error) => {
        if (error.code === 'P2002')
          throw new ConflictException(
            'Este cliente já possui um destino ativo para chamadas',
          );
        throw error;
      });
  }

  @Patch('endpoints/:id')
  async updateEndpoint(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWebhookEndpointDto,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');

    // Verify endpoint ownership
    const endpoint = await this.prisma.webhook_endpoints.findFirst({
      where: {
        id,
        painel_clients: {
          company_id: ctx.companyId,
        },
      },
    });

    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }

    await this.validateExportEndpoint(
      body.url ?? endpoint.url,
      body.events ?? (endpoint.events as string[]),
      endpoint.client_id,
      body.enabled ?? endpoint.enabled,
      id,
    );
    const policy = (endpoint.retry_policy || {}) as Record<string, any>;
    return this.prisma.webhook_endpoints
      .update({
        where: { id },
        data: {
          url: body.url,
          events: body.events,
          enabled: body.enabled,
          secret_hash:
            !endpoint.secret_hash &&
            ((body.events ?? endpoint.events) as string[]).includes(
              'call.completed',
            )
              ? 'whsec_' + randomBytes(24).toString('hex')
              : undefined,
          updated_at: new Date(),
          retry_policy: {
            ...policy,
            retention_hours:
              body.retention_hours ?? policy.retention_hours ?? 24,
            include_transcript:
              body.include_transcript ?? policy.include_transcript ?? false,
          },
        },
      })
      .catch((error) => {
        if (error.code === 'P2002')
          throw new ConflictException(
            'Este cliente já possui um destino ativo para chamadas',
          );
        throw error;
      });
  }

  @Delete('endpoints/:id')
  async deleteEndpoint(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');

    // Verify endpoint ownership
    const endpoint = await this.prisma.webhook_endpoints.findFirst({
      where: {
        id,
        painel_clients: {
          company_id: ctx.companyId,
        },
      },
    });

    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }

    // Clean up deliveries first to prevent DB constraint errors
    await this.prisma.webhook_deliveries.deleteMany({
      where: { webhook_endpoint_id: id },
    });

    return this.prisma.webhook_endpoints.delete({
      where: { id },
    });
  }

  private async validateExportEndpoint(
    url: string,
    events: string[],
    clientId: string,
    enabled: boolean,
    id?: string,
  ) {
    if (!events.includes('call.completed')) return;
    if (
      new URL(url).protocol !== 'https:' ||
      new URL(url).username ||
      new URL(url).password
    )
      throw new BadRequestException('A entrega de chamadas exige HTTPS');
    if ((process.env.ENCRYPTION_KEY || '').length < 32)
      throw new BadRequestException(
        'Configure ENCRYPTION_KEY antes de ativar a entrega de chamadas',
      );
    await validateWebhookUrl(url);
    if (
      enabled &&
      (await this.prisma.webhook_endpoints.findFirst({
        where: {
          client_id: clientId,
          enabled: true,
          ...(id ? { id: { not: id } } : {}),
          events: { array_contains: 'call.completed' },
        },
      }))
    )
      throw new ConflictException(
        'Este cliente já possui um destino ativo para chamadas',
      );
  }

  @Get('call-exports')
  async listCallExports(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');
    return this.prisma.call_exports.findMany({
      where: {
        company_id: ctx.companyId,
        ...(clientId ? { client_id: clientId } : {}),
      },
      select: {
        id: true,
        conversation_id: true,
        client_id: true,
        endpoint_id: true,
        status: true,
        attempt: true,
        http_status: true,
        error_code: true,
        created_at: true,
        delivered_at: true,
        purged_at: true,
        expires_at: true,
        next_attempt_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  @Get('deliveries')
  async listDeliveries(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const ctx = extractTenantContext(user);
    if (!ctx.companyId)
      throw new UnauthorizedException('Empresa não identificada');
    const take = limit ? parseInt(limit, 10) : 50;
    const skip = offset ? parseInt(offset, 10) : 0;

    return this.prisma.webhook_deliveries.findMany({
      where: {
        webhook_endpoints: {
          ...(clientId ? { client_id: clientId } : {}),
          painel_clients: {
            company_id: ctx.companyId,
          },
        },
      },
      include: {
        webhook_endpoints: {
          select: {
            url: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take,
      skip,
    });
  }
}
