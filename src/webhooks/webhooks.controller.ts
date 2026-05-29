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
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { randomBytes } from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('endpoints')
  async listEndpoints(@CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.prisma.webhook_endpoints.findMany({
      where: {
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
    @Body() body: CreateWebhookEndpointDto & { client_id: string },
  ) {
    const ctx = extractTenantContext(user);

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

    const secretHash = 'whsec_' + randomBytes(24).toString('hex');

    return this.prisma.webhook_endpoints.create({
      data: {
        client_id: body.client_id,
        url: body.url,
        events: body.events,
        secret_hash: secretHash,
        enabled: body.enabled ?? true,
        retry_policy: { max_retries: 3 } as any,
      },
    });
  }

  @Patch('endpoints/:id')
  async updateEndpoint(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Partial<CreateWebhookEndpointDto>,
  ) {
    const ctx = extractTenantContext(user);

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

    return this.prisma.webhook_endpoints.update({
      where: { id },
      data: {
        url: body.url,
        events: body.events,
        enabled: body.enabled,
        updated_at: new Date(),
      },
    });
  }

  @Delete('endpoints/:id')
  async deleteEndpoint(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = extractTenantContext(user);

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

  @Get('deliveries')
  async listDeliveries(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const ctx = extractTenantContext(user);
    const take = limit ? parseInt(limit, 10) : 50;
    const skip = offset ? parseInt(offset, 10) : 0;

    return this.prisma.webhook_deliveries.findMany({
      where: {
        webhook_endpoints: {
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
