import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Injectable()
export class SipAccessService {
  private readonly logger = new Logger(SipAccessService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async client(user: unknown, clientId: string) {
    const ctx = extractTenantContext(user);
    if (!['platform_admin', 'company_admin'].includes(ctx.role))
      throw new ForbiddenException('Acesso negado');
    const client = await this.prisma.painel_clients.findFirst({
      where: {
        id: clientId,
        ...(ctx.role === 'platform_admin'
          ? {}
          : { company_id: ctx.companyId || '' }),
        companies: { status: 'active' },
      },
      select: { id: true, company_id: true },
    });
    if (!client) throw new NotFoundException('Cliente não encontrado');
    return client;
  }

  private server() {
    const host = this.config.get<string>('SIP_PUBLIC_HOST');
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host))
      throw new ServiceUnavailableException(
        'Telefonia SIP ainda não configurada',
      );
    return { host, port: 5060, transport: 'UDP', realm: 'asterisk' };
  }

  async get(user: unknown, clientId: string) {
    await this.client(user, clientId);
    const account = await this.prisma.sip_accounts.findUnique({
      where: { client_id: clientId },
      select: { username: true, enabled: true, updated_at: true },
    });
    return { ...this.server(), account };
  }

  async generate(user: unknown, clientId: string, rotate = false) {
    const client = await this.client(user, clientId);
    const server = this.server();
    const existing = await this.prisma.sip_accounts.findUnique({
      where: { client_id: clientId },
      select: { username: true },
    });
    if (existing && !rotate)
      throw new ConflictException(
        'O acesso já existe. Use Gerar nova senha para substituí-lo.',
      );
    const username =
      existing?.username || `sx_${randomBytes(12).toString('hex')}`;
    const password = randomBytes(24).toString('base64url');
    // Asterisk 20.6 SIP Digest requires HA1; treat it as a secret, never serialize it.
    const digest = createHash('md5')
      .update(`${username}:asterisk:${password}`)
      .digest('hex');
    const data = {
      company_id: client.company_id,
      username,
      digest,
      enabled: true,
    };
    if (rotate) {
      await this.prisma.sip_accounts.update({
        where: { client_id: clientId },
        data,
      });
    } else {
      try {
        await this.prisma.sip_accounts.create({
          data: { ...data, client_id: clientId },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002')
          throw new ConflictException('Acesso já criado. Atualize a página.');
        throw error;
      }
    }
    this.logger.log({
      event: rotate ? 'sip_access_rotated' : 'sip_access_created',
      clientId,
      companyId: client.company_id,
    });
    return { ...server, account: { username, enabled: true }, password };
  }

  async revoke(user: unknown, clientId: string) {
    const client = await this.client(user, clientId);
    await this.prisma.sip_accounts.updateMany({
      where: { client_id: clientId },
      data: { enabled: false },
    });
    this.logger.log({
      event: 'sip_access_revoked',
      clientId,
      companyId: client.company_id,
    });
    return { ok: true };
  }
}
