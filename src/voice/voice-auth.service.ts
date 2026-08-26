import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionService } from '../common/auth/session.service';

export interface VoiceAuthenticatedUser {
  id: string;
  company_id: string;
  role: string;
}

@Injectable()
export class VoiceAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async authenticateSession(
    sessionId: string,
  ): Promise<VoiceAuthenticatedUser> {
    const session = await this.sessionService.get(sessionId);
    if (!session) {
      throw new UnauthorizedException('Sessão de voz inválida');
    }
    return this.loadUser(session.user.id);
  }

  async resolveClientId(
    companyId: string,
    requestedClientId?: string,
  ): Promise<string | undefined> {
    if (requestedClientId) {
      const client = await this.prisma.painel_clients.findFirst({
        where: { id: requestedClientId, company_id: companyId },
        select: { id: true },
      });

      if (!client) {
        throw new UnauthorizedException('Cliente de voz não autorizado');
      }

      return client.id;
    }

    const defaultClient = await this.prisma.painel_clients.findFirst({
      where: { company_id: companyId, status: 'active' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    return defaultClient?.id;
  }

  private async loadUser(userId?: string): Promise<VoiceAuthenticatedUser> {
    if (!userId) {
      throw new UnauthorizedException('Sessão de voz inválida');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        company_id: true,
        role: true,
        companies: { select: { status: true } },
      },
    });

    if (!user?.company_id || user.companies.status !== 'active') {
      throw new UnauthorizedException('Usuário de voz não autorizado');
    }

    return {
      id: user.id,
      company_id: user.company_id,
      role: user.role,
    };
  }
}
