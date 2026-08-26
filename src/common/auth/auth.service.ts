import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type User } from '@supabase/supabase-js';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../mail/mail.service';
import { SessionService } from './session.service';
import type { SessionUser } from './session.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    private readonly mailService: MailService,
    private readonly sessionService: SessionService,
  ) {}

  async login(email: string, password: string): Promise<SessionUser> {
    const normalizedEmail = email.trim().toLowerCase();
    const rate = await this.redis.checkRateLimit(
      `auth:login:email:${normalizedEmail}`,
      5,
      60,
    );
    if (!rate.allowed) {
      throw new HttpException(
        'Muitas tentativas. Tente novamente em instantes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.provider() === 'local') {
      return this.loginLocal(normalizedEmail, password);
    }

    const supabaseUser = await this.loginSupabase(normalizedEmail, password);
    return this.loadUser(
      supabaseUser.id,
      supabaseUser.email ?? normalizedEmail,
    );
  }

  async requestMagicLink(email: string, redirectTo: string): Promise<void> {
    if (this.provider() !== 'supabase') {
      throw new BadRequestException('Magic Link indisponível neste ambiente');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const rate = await this.redis.checkRateLimit(
      `auth:magic-link:email:${normalizedEmail}`,
      3,
      60,
    );
    if (!rate.allowed) {
      throw new HttpException(
        'Muitas solicitações. Tente novamente em instantes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const supabase = this.supabaseClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      this.logger.warn(`Falha ao solicitar Magic Link: ${error.message}`);
      throw new BadRequestException('Não foi possível enviar o link de acesso');
    }
  }

  async completeMagicLink(code: string): Promise<SessionUser> {
    if (this.provider() !== 'supabase') {
      throw new BadRequestException('Magic Link indisponível neste ambiente');
    }

    const supabase = this.supabaseClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user) {
      throw new UnauthorizedException('Link de acesso inválido ou expirado');
    }

    return this.loadUser(data.user.id, data.user.email ?? '');
  }

  private async loginLocal(
    email: string,
    password: string,
  ): Promise<SessionUser> {
    const user = await this.prisma.users.findUnique({
      where: { email },
      include: {
        companies: { select: { id: true, name: true, status: true } },
      },
    });

    if (
      !user?.password_hash ||
      user.companies.status !== 'active' ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    return {
      id: user.id,
      email: user.email ?? email,
      name: user.name,
      role: user.role,
      company_id: user.company_id,
      company_name: user.companies?.name ?? null,
    };
  }

  private async loginSupabase(email: string, password: string): Promise<User> {
    const { data, error } = await this.supabaseClient().auth.signInWithPassword(
      {
        email,
        password,
      },
    );

    if (error || !data.user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    return data.user;
  }

  private async loadUser(userId: string, email: string): Promise<SessionUser> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: {
        companies: { select: { id: true, name: true, status: true } },
      },
    });

    if (!user || !user.company_id || user.companies.status !== 'active') {
      throw new UnauthorizedException('Usuário não autorizado');
    }

    return {
      id: user.id,
      email: user.email || email,
      name: user.name,
      role: user.role,
      company_id: user.company_id,
      company_name: user.companies?.name ?? null,
    };
  }

  async requestPasswordReset(
    email: string,
    resetUrlBase: string,
  ): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
      include: { companies: { select: { status: true } } },
    });

    if (!user || !user.company_id || user.companies.status !== 'active') {
      return;
    }

    if (this.provider() === 'supabase') {
      const { error } = await this.supabaseClient().auth.resetPasswordForEmail(
        normalizedEmail,
        { redirectTo: resetUrlBase },
      );
      if (error) {
        this.logger.warn(`Falha ao solicitar reset Supabase: ${error.message}`);
      }
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.redis.set(`auth:reset:${tokenHash}`, user.id, 30 * 60);
    await this.mailService.sendPasswordResetEmail(
      normalizedEmail,
      `${resetUrlBase}?token=${token}`,
    );
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token.trim()).digest('hex');
    const userId = await this.redis.get<string>(`auth:reset:${tokenHash}`);

    if (!userId) {
      throw new UnauthorizedException('Token inválido ou expirado');
    }

    await this.prisma.users.update({
      where: { id: userId },
      data: { password_hash: await bcrypt.hash(password, 10) },
    });
    await this.redis.del(`auth:reset:${tokenHash}`);
    await this.sessionService.destroyAllForUser(userId);
  }

  private supabaseClient() {
    const url = this.configService.get<string>('SUPABASE_URL', '');
    const key = this.configService.get<string>('SUPABASE_PUBLISH_KEY', '');
    if (!url || !key) {
      throw new UnauthorizedException('Autenticação Supabase não configurada');
    }

    return createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  private provider(): 'local' | 'supabase' {
    const configured = this.configService.get<string>('AUTH_PROVIDER');
    if (configured === 'supabase') return 'supabase';
    if (configured === 'local') return 'local';
    return this.configService.get<string>('ENVIRONMENT') === 'production'
      ? 'supabase'
      : 'local';
  }
}
