import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';
import { TelephonyEndpointResolverService } from './services/telephony-endpoint-resolver.service';

/**
 * API de configuração plug-and-play da telefonia.
 * Cada endpoint roteia um DID/provedor (NexCore, CallFlex, Twilio SIP...)
 * para empresa/cliente/agente sem necessidade de código novo.
 */
@Controller('voice/telephony-endpoints')
export class TelephonyEndpointsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly resolver: TelephonyEndpointResolverService,
  ) {}

  @Get()
  async list(@CurrentUser() user: any) {
    const ctx = this.requireCtx(user);
    return this.prisma.telephony_endpoints.findMany({
      where: { company_id: ctx.companyId },
      include: {
        painel_clients: { select: { company_name: true } },
      },
      orderBy: [{ did_number: 'asc' }],
    });
  }

  @Post()
  async create(
    @CurrentUser() user: any,
    @Body()
    body: {
      provider: string;
      did_number: string;
      client_id?: string;
      label?: string;
      agent_step?: string;
      audio_format?: string;
      inbound_secret?: string;
      config?: Record<string, unknown>;
    },
  ) {
    const ctx = this.requireCtx(user);

    if (!body.provider?.trim() || !body.did_number?.trim()) {
      throw new ForbiddenException('provider e did_number são obrigatórios');
    }

    if (body.client_id) {
      const client = await this.prisma.painel_clients.findFirst({
        where: { id: body.client_id, company_id: ctx.companyId },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Cliente não encontrado');
    }

    // Segredo opcional p/ ingresso WS; se ausente, gera token forte.
    const plaintextSecret =
      body.inbound_secret || `syn_${randomBytes(24).toString('hex')}`;
    const tokenHash = this.hashSecret(plaintextSecret);

    const endpoint = await this.prisma.telephony_endpoints.create({
      data: {
        company_id: ctx.companyId,
        client_id: body.client_id || null,
        provider: body.provider.trim().toLowerCase(),
        did_number: body.did_number.trim(),
        label: body.label || null,
        agent_step: body.agent_step || null,
        audio_format: body.audio_format || 'g711_ulaw',
        inbound_secret_hash: tokenHash,
        config: (body.config || {}) as any,
      },
    });

    await this.resolver.invalidate(endpoint.did_number);

    return {
      ...endpoint,
      // O segredo é retornado UMA única vez para o operador copiar/discar
      // no discador. Só o hash fica persistido.
      generated_token: plaintextSecret,
    };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: Partial<{
      label: string;
      agent_step: string | null;
      audio_format: string;
      enabled: boolean;
      client_id: string | null;
    }>,
  ) {
    const ctx = this.requireCtx(user);
    await this.assertOwnership(id, ctx.companyId);

    const updated = await this.prisma.telephony_endpoints.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.agent_step !== undefined
          ? { agent_step: body.agent_step }
          : {}),
        ...(body.audio_format ? { audio_format: body.audio_format } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.client_id !== undefined ? { client_id: body.client_id } : {}),
        updated_at: new Date(),
      },
    });

    await this.resolver.invalidate(updated.did_number);
    return updated;
  }

  /**
   * Rotaciona o segredo do ingresso WS do discador.
   */
  @Post(':id/rotate-secret')
  async rotateSecret(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = this.requireCtx(user);
    await this.assertOwnership(id, ctx.companyId);

    const plaintext = `syn_${randomBytes(24).toString('hex')}`;
    const tokenHash = this.hashSecret(plaintext);
    const updated = await this.prisma.telephony_endpoints.update({
      where: { id },
      data: { inbound_secret_hash: tokenHash, updated_at: new Date() },
    });

    return { id: updated.id, generated_token: plaintext };
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = this.requireCtx(user);
    const existing = await this.assertOwnership(id, ctx.companyId);

    await this.prisma.telephony_endpoints.delete({ where: { id } });
    await this.resolver.invalidate(existing.did_number);
    return { deleted: true };
  }

  private hashSecret(secret: string): string {
    const pepper =
      this.configService.get<string>('TELEPHONY_WS_TOKEN_PEPPER') || '';
    return createHash('sha256').update(`${secret}${pepper}`).digest('hex');
  }

  private requireCtx(user: any) {
    if (!user) throw new UnauthorizedException();
    return extractTenantContext(user);
  }

  private async assertOwnership(id: string, companyId: string) {
    const endpoint = await this.prisma.telephony_endpoints.findUnique({
      where: { id },
    });
    if (!endpoint || endpoint.company_id !== companyId) {
      throw new NotFoundException('Endpoint de telefonia não encontrado');
    }
    return endpoint;
  }
}
