import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
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
import { IMPERSONATION_TTL_MS } from './session.service';
import { ROLES } from './roles.constants';

export const DUMMY_PASSWORD_HASH =
  '$2b$10$XW5ATkoiQmMvAX/B1PGy3.86FWR2WNZH5KG1n8NKaI9eZACX14gLy';

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

  async login(
    email: string,
    password: string,
    ip?: string,
  ): Promise<SessionUser> {
    const normalizedEmail = email.trim().toLowerCase();

    if (ip) {
      const ipRate = await this.redis.checkRateLimit(
        `auth:login:ip:${ip}`,
        20,
        60,
      );
      if (!ipRate.allowed) {
        throw new HttpException(
          'Muitas tentativas. Tente novamente em instantes.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const rate = await this.redis.checkRateLimit(
      ip
        ? `auth:login:${ip}:${normalizedEmail}`
        : `auth:login:email:${normalizedEmail}`,
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
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    });

    if (error) {
      this.logger.warn(`Falha ao solicitar Magic Link: ${error.message}`);
      throw new BadRequestException('Não foi possível enviar o link de acesso');
    }
  }

  async completeMagicLink(token: string): Promise<SessionUser> {
    if (this.provider() !== 'supabase') {
      throw new BadRequestException('Magic Link indisponível neste ambiente');
    }

    const supabase = this.supabaseClient();
    const claims = await this.emailLinkClaims(supabase, token, 'magiclink');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user || data.user.id !== claims.sub) {
      throw new UnauthorizedException('Link de acesso inválido ou expirado');
    }

    const user = await this.loadUser(data.user.id, data.user.email ?? '');
    if (
      !(await this.redis.acquireLock(
        `auth:email-link:used:${claims.session_id}`,
        3660,
      ))
    ) {
      throw new UnauthorizedException('Link de acesso já utilizado');
    }
    return user;
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

    const passwordMatches = await bcrypt.compare(
      password,
      user?.password_hash ?? DUMMY_PASSWORD_HASH,
    );

    if (
      !user?.password_hash ||
      user.invitation_pending ||
      user.companies.status !== 'active' ||
      !passwordMatches
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

    if (
      !user ||
      user.invitation_pending ||
      !user.company_id ||
      user.companies.status !== 'active'
    ) {
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

  /**
   * platform_admin passa a enxergar o sistema como membro da empresa alvo
   * (visualização temporária dentro da MESMA sessão). A identidade real é
   * preservada nos campos `original_*` e restaurável via exitImpersonation.
   */
  async enterImpersonation(
    user: SessionUser,
    companyId: string,
    actor?: SessionUser,
  ): Promise<SessionUser> {
    const gate = actor ?? user;
    if ((gate.original_role ?? gate.role) !== ROLES.PLATFORM_ADMIN) {
      throw new ForbiddenException(
        'Apenas platform_admin pode usar esta função',
      );
    }
    if (user.original_role) {
      throw new BadRequestException(
        'Já existe uma visualização ativa — encerre-a antes de trocar',
      );
    }

    const company = await this.prisma.companies.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, status: true },
    });
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }
    if (company.status !== 'active') {
      throw new BadRequestException('Empresa suspensa não pode ser acessada');
    }
    if (user.company_id === company.id && !user.original_role) {
      // Já é a empresa de origem do admin; nada a fazer.
      return user;
    }

    return {
      ...user,
      original_role: user.role,
      original_company_id: user.company_id,
      original_company_name: user.company_name ?? null,
      role: ROLES.COMPANY_ADMIN,
      company_id: company.id,
      company_name: company.name,
      impersonating_until: Date.now() + IMPERSONATION_TTL_MS,
    };
  }

  /** Restaura a identidade real do platform_admin. */
  exitImpersonation(user: SessionUser): SessionUser {
    if (!user.original_role || !user.original_company_id) {
      throw new BadRequestException('Nenhuma visualização de empresa ativa');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.original_role,
      company_id: user.original_company_id,
      company_name: user.original_company_name ?? null,
    };
  }

  async requestPasswordReset(
    email: string,
    resetUrlBase: string,
  ): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const rate = await this.redis.checkRateLimit(
      `auth:forgot:email:${normalizedEmail}`,
      3,
      300,
    );
    if (!rate.allowed) {
      throw new HttpException(
        'Muitas tentativas. Tente novamente em instantes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
      include: { companies: { select: { status: true } } },
    });

    if (
      !user ||
      user.invitation_pending ||
      !user.company_id ||
      user.companies.status !== 'active'
    ) {
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

  async resetPassword(
    token: string,
    password: string,
    refreshToken?: string,
  ): Promise<void> {
    if (this.provider() === 'supabase') {
      return this.resetSupabasePassword(token, password, refreshToken);
    }
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

  private async emailLinkClaims(
    client: ReturnType<AuthService['supabaseClient']>,
    token: string,
    method: 'recovery' | 'magiclink',
  ) {
    // getClaims verifies the signature and expiry; never trust a decoded JWT alone.
    const { data, error } = await client.auth.getClaims(token);
    const claims = data?.claims;
    const now = Math.floor(Date.now() / 1000);
    // The implicit /verify flow signs BOTH magic links and recovery links as OTP.
    // URL type is not a signed purpose claim. Accept the verified OTP proof and
    // consume its session once across both endpoints; never trust URL type alone.
    const recentLink = claims?.amr?.some(
      (entry) =>
        (entry.method === method || entry.method === 'otp') &&
        Number.isFinite(entry.timestamp) &&
        entry.timestamp <= now + 30 &&
        entry.timestamp > now - 3600,
    );
    if (error || !claims?.session_id || !recentLink) {
      this.logger.warn({
        event: 'email_link_rejected',
        requested_flow: method,
        reason:
          error || !claims
            ? 'invalid_token'
            : !claims.session_id
              ? 'missing_session'
              : 'unsupported_or_stale_authentication',
      });
      throw new UnauthorizedException(
        'Link inválido ou expirado. Solicite um novo link.',
      );
    }
    return claims;
  }

  private async resetSupabasePassword(
    token: string,
    password: string,
    refreshToken?: string,
  ) {
    if (!refreshToken)
      throw new UnauthorizedException(
        'Link incompleto. Solicite um novo link.',
      );
    const client = this.supabaseClient();
    const claims = await this.emailLinkClaims(client, token, 'recovery');
    const identity = await client.auth.setSession({
      access_token: token,
      refresh_token: refreshToken,
    });
    if (
      identity.error ||
      !identity.data.user ||
      identity.data.user.id !== claims.sub
    ) {
      throw new UnauthorizedException(
        'Link inválido ou expirado. Solicite um novo link.',
      );
    }
    const user = await this.loadUser(
      identity.data.user.id,
      identity.data.user.email ?? '',
    );
    // Keep the lock through the recovery window after success (also blocks refreshed JWTs).
    const key = `auth:email-link:used:${claims.session_id}`;
    if (!(await this.redis.acquireLock(key, 3660))) {
      throw new UnauthorizedException(
        'Link já utilizado ou redefinição em andamento.',
      );
    }
    const { error } = await client.auth.updateUser({ password });
    if (error) {
      await this.redis.releaseLock(key);
      this.logger.warn({
        event: 'password_reset_failed',
        provider: 'supabase',
        code: error.code,
      });
      throw new BadRequestException(
        error.code === 'same_password'
          ? 'Escolha uma senha diferente da senha atual.'
          : 'Não foi possível redefinir a senha. Verifique os requisitos ou solicite um novo link.',
      );
    }
    await this.sessionService.destroyAllForUser(user.id);
    const signOut = await client.auth.signOut({ scope: 'global' });
    if (signOut.error)
      this.logger.warn({ event: 'password_reset_provider_signout_failed' });
    this.logger.log({
      event: 'password_reset_completed',
      provider: 'supabase',
      user_id: user.id,
    });
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
