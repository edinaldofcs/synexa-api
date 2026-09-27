import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  clearAuthCookies,
  getSessionId,
  hasTrustedOrigin,
  hasValidCsrfToken,
  setAuthCookies,
} from './auth-cookie';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';
import {
  SessionService,
  SESSION_TTL_SECONDS,
  type SessionUser,
} from './session.service';
import { LoginDto } from './dto/login.dto';
import { MagicLinkDto, CompleteMagicLinkDto } from './dto/magic-link.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ImpersonateDto } from './dto/impersonate.dto';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, Logger } from '@nestjs/common';
import type { AuthSession } from './session.service';
import { isPlatformOwner } from './platform-owner.guard';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
    @Req() request: Request,
  ) {
    const user = await this.authService.login(
      body.email,
      body.password,
      request.ip,
    );
    const session = await this.sessionService.create(user);
    setAuthCookies(
      response,
      this.configService,
      session.id,
      session.csrfToken,
      SESSION_TTL_SECONDS * 1000,
    );
    return { user };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('magic-link')
  async magicLink(@Body() body: MagicLinkDto, @Req() request: Request) {
    await this.authService.requestMagicLink(
      body.email,
      this.callbackUrl(request),
    );
    return { ok: true };
  }

  @Public()
  @Get('callback')
  callback(@Res() response: Response) {
    // Old emails target the API. Browsers preserve the fragment through this redirect.
    return response.redirect(this.frontendUrl('/auth/callback'));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('magic-link/complete')
  async completeMagicLink(
    @Body() body: CompleteMagicLinkDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.authService.completeMagicLink(body.token);
    const session = await this.sessionService.create(user);
    setAuthCookies(
      response,
      this.configService,
      session.id,
      session.csrfToken,
      SESSION_TTL_SECONDS * 1000,
    );
    return { user };
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return {
      user: {
        ...user,
        is_platform_owner: isPlatformOwner(
          user,
          this.configService.get<string>('PLATFORM_OWNER_USER_ID'),
        ),
      },
    };
  }

  /**
   * platform_admin "transita" para enxergar o painel como a empresa alvo.
   * A troca acontece dentro da mesma sessão (identidade real preservada).
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('impersonate')
  async impersonate(@Body() body: ImpersonateDto, @Req() request: Request) {
    const session = await this.requireMutableSession(request);
    const effective = await this.authService.enterImpersonation(
      session.user,
      body.company_id,
      request.user as SessionUser | undefined,
    );
    session.user = effective;
    await this.sessionService.save(session);
    this.logImpersonation('impersonation_enter', effective, request);
    return { user: effective };
  }

  /** Volta para a identidade real do platform_admin. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('impersonation/exit')
  async exitImpersonation(@Req() request: Request) {
    const session = await this.requireMutableSession(request);
    const restored = this.authService.exitImpersonation(session.user);
    const viewing = session.user;
    session.user = restored;
    await this.sessionService.save(session);
    this.logImpersonation('impersonation_exit', viewing, request);
    return { user: restored };
  }

  private async requireMutableSession(request: Request): Promise<AuthSession> {
    const sessionId = getSessionId(request);
    const session = sessionId ? await this.sessionService.get(sessionId) : null;
    if (
      !session ||
      !hasTrustedOrigin(request, this.configService) ||
      !hasValidCsrfToken(request, session.csrfToken)
    ) {
      throw new ForbiddenException('Proteção CSRF inválida');
    }
    return session;
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const sessionId = getSessionId(request);
    if (sessionId) {
      const session = await this.sessionService.get(sessionId);
      if (
        session &&
        (!hasTrustedOrigin(request, this.configService) ||
          !hasValidCsrfToken(request, session.csrfToken))
      ) {
        throw new ForbiddenException('Proteção CSRF inválida');
      }
      await this.sessionService.destroy(sessionId);
    }

    clearAuthCookies(response, this.configService);
    return { ok: true };
  }

  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: SessionUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const sessionId = getSessionId(request);
    const session = sessionId ? await this.sessionService.get(sessionId) : null;
    if (
      !session ||
      !hasTrustedOrigin(request, this.configService) ||
      !hasValidCsrfToken(request, session.csrfToken)
    ) {
      throw new ForbiddenException('Proteção CSRF inválida');
    }

    await this.sessionService.destroyAllForUser(user.id);
    clearAuthCookies(response, this.configService);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(
    @Body() body: ForgotPasswordDto,
    @Req() request: Request,
  ) {
    await this.authService.requestPasswordReset(
      body.email,
      this.frontendUrl('/reset-password'),
    );
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    await this.authService.resetPassword(
      body.token,
      body.password,
      body.refreshToken,
    );
    return { ok: true };
  }

  private logImpersonation(
    action: 'impersonation_enter' | 'impersonation_exit',
    user: SessionUser,
    request: Request,
  ) {
    this.logger.log(
      JSON.stringify({
        action,
        actor_id: user.id,
        actor_email: user.email,
        original_company_id: user.original_company_id ?? user.company_id,
        target_company_id: user.company_id,
        ip: request.ip,
        user_agent: request.get('user-agent'),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private callbackUrl(request: Request) {
    const frontend = this.configService.get<string>('AUTH_FRONTEND_URL');
    if (frontend) return `${frontend.replace(/\/+$/, '')}/auth/callback`;
    const configured = this.configService.get<string>('AUTH_CALLBACK_URL');
    if (configured) return configured;

    // Nunca confiar no header Host (host header injection no e-mail do
    // magic link): deriva da origem configurada via CORS_ORIGIN
    const corsOrigin = this.configService.get<string>('CORS_ORIGIN', '');
    const trustedOrigin = (corsOrigin || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (trustedOrigin) {
      return `${trustedOrigin.replace(/\/+$/, '')}/api/auth/callback`;
    }

    // Host header apenas como último recurso em development
    const environment = this.configService.get<string>('ENVIRONMENT');
    if (environment === 'development') {
      return `${request.protocol}://${request.get('host')}/api/auth/callback`;
    }

    throw new Error(
      'AUTH_CALLBACK_URL ou CORS_ORIGIN deve estar configurado em produção',
    );
  }

  private frontendUrl(path: string) {
    const base = this.configService.get<string>('AUTH_FRONTEND_URL', '');
    return base ? `${base.replace(/\/+$/, '')}${path}` : path;
  }
}
