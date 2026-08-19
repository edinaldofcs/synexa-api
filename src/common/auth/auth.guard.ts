import {
  ExecutionContext,
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

@Injectable()
export class AuthGuard extends PassportAuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if ((process.env.ENVIRONMENT || 'development') !== 'development') {
      return this.validateSupabaseToken(context);
    }

    return (await super.canActivate(context)) as boolean;
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
          select: { role: true, company_id: true },
        })
      : null;

    request.user = {
      id: data.user.id,
      email: data.user.email,
      role: dbUser?.role || data.user.app_metadata?.role || data.user.role,
      company_id:
        dbUser?.company_id || data.user.app_metadata?.company_id || null,
    };

    return true;
  }
}
