import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  getSessionId,
  hasTrustedOrigin,
  hasValidCsrfToken,
} from './auth-cookie';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';

@Injectable()
export class AuthGuard extends PassportAuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly sessionService?: SessionService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const sessionId = getSessionId(request);
    if (sessionId && this.sessionService) {
      const session = await this.sessionService.get(sessionId);
      if (session) {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
          if (
            !this.configService ||
            !hasTrustedOrigin(request, this.configService) ||
            !hasValidCsrfToken(request, session.csrfToken)
          ) {
            throw new ForbiddenException('Proteção CSRF inválida');
          }
        }

        request.user = this.prisma
          ? await this.loadActiveSessionUser(session.user)
          : session.user;
        if (!request.user) {
          await this.sessionService.destroy(sessionId);
          throw new UnauthorizedException('Usuário não autorizado');
        }
        return true;
      }
    }

    const env = process.env.ENVIRONMENT;
    if (env !== 'development' && env !== 'test') {
      return this.validateSupabaseToken(context);
    }

    return (await super.canActivate(context)) as boolean;
  }

  private async loadActiveSessionUser(
    sessionUser: SessionUser,
  ): Promise<Record<string, unknown> | null> {
    const user = await this.prisma!.users.findUnique({
      where: { id: sessionUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        company_id: true,
        companies: { select: { name: true, status: true } },
      },
    });

    if (!user || user.companies.status !== 'active') return null;

    const base = {
      id: user.id,
      email: user.email ?? sessionUser.email,
      name: user.name ?? sessionUser.name ?? null,
      role: user.role,
      company_id: user.company_id,
      company_name: user.companies?.name ?? sessionUser.company_name ?? null,
    };

    const isImpersonating =
      !!sessionUser.original_role &&
      !!sessionUser.original_company_id &&
      !!sessionUser.company_id;

    if (!isImpersonating) return base;

    // Visualização válida somente enquanto a empresa alvo estiver ativa.
    const target = await this.prisma!.companies.findUnique({
      where: { id: sessionUser.company_id as string },
      select: { status: true },
    });
    if (!target || target.status !== 'active') return base;

    return {
      ...base,
      role: sessionUser.role,
      company_id: sessionUser.company_id,
      company_name: sessionUser.company_name ?? base.company_name,
      original_role: sessionUser.original_role,
      original_company_id: sessionUser.original_company_id,
      original_company_name: sessionUser.original_company_name ?? null,
    };
  }

  private async validateSupabaseToken(
    context: ExecutionContext,
  ): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: Record<string, unknown>;
    }>();
    const authorization = request.headers.authorization || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';

    if (!token || !this.configService) {
      throw new UnauthorizedException('Token de acesso ausente');
    }

    const supabaseUrl = this.configService.get<string>('SUPABASE_URL', '');
    const serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
      '',
    );

    if (!supabaseUrl || !serviceRoleKey) {
      throw new UnauthorizedException('Autenticação Supabase não configurada');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      throw new UnauthorizedException('Token de acesso inválido');
    }

    const dbUser = this.prisma
      ? await this.prisma.users.findUnique({
          where: { id: data.user.id },
          select: {
            role: true,
            company_id: true,
            companies: { select: { status: true } },
          },
        })
      : null;

    if (!dbUser || dbUser.companies.status !== 'active') {
      throw new UnauthorizedException('Usuário não autorizado');
    }

    request.user = {
      id: data.user.id,
      email: data.user.email,
      role: dbUser.role,
      company_id: dbUser.company_id,
    };

    return true;
  }
}
