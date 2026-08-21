import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../common/prisma/prisma.service';

export interface VoiceAuthenticatedUser {
  id: string;
  company_id: string;
  role: string;
}

@Injectable()
export class VoiceAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(accessToken: string): Promise<VoiceAuthenticatedUser> {
    if (!accessToken?.trim()) {
      throw new UnauthorizedException('Autenticação de voz obrigatória');
    }

    const environment = this.configService.get<string>(
      'ENVIRONMENT',
      'development',
    );

    if (environment === 'development') {
      return this.authenticateLocal(accessToken);
    }

    return this.authenticateSupabase(accessToken);
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

  private async authenticateLocal(
    accessToken: string,
  ): Promise<VoiceAuthenticatedUser> {
    let payload: { sub?: string };

    try {
      payload = await this.jwtService.verifyAsync<{ sub?: string }>(
        accessToken,
        {
          secret: this.configService.get<string>('JWT_SECRET'),
          issuer: 'synexa-local',
          algorithms: ['HS256'],
        },
      );
    } catch {
      throw new UnauthorizedException('Token de voz inválido');
    }

    return this.loadUser(payload.sub);
  }

  private async authenticateSupabase(
    accessToken: string,
  ): Promise<VoiceAuthenticatedUser> {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL', '');
    const serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
      '',
    );

    if (!supabaseUrl || !serviceRoleKey) {
      throw new UnauthorizedException('Autenticação de voz indisponível');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      throw new UnauthorizedException('Token de voz inválido');
    }

    return this.loadUser(data.user.id);
  }

  private async loadUser(userId?: string): Promise<VoiceAuthenticatedUser> {
    if (!userId) {
      throw new UnauthorizedException('Token de voz inválido');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, company_id: true, role: true },
    });

    if (!user?.company_id) {
      throw new UnauthorizedException('Usuário de voz não autorizado');
    }

    return user;
  }
}
