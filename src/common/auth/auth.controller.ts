import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
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
import { MagicLinkDto } from './dto/magic-link.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ImpersonateDto } from './dto/impersonate.dto';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { AuthSession } from './session.service';

@Controller('auth')
export class AuthController {
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
  ) {
    const user = await this.authService.login(body.email, body.password);
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
  async callback(
    @Query('code') code: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      if (!code) throw new UnauthorizedException('Código de acesso ausente');
      const user = await this.authService.completeMagicLink(code);
      const session = await this.sessionService.create(user);
      setAuthCookies(
        response,
        this.configService,
        session.id,
        session.csrfToken,
        SESSION_TTL_SECONDS * 1000,
      );
      return response.redirect(this.frontendUrl('/dashboard'));
    } catch {
      return response.redirect(this.frontendUrl('/login?error=magic_link'));
    }
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return { user };
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
    );
    session.user = effective;
    await this.sessionService.save(session);
    return { user: effective };
  }

  /** Volta para a identidade real do platform_admin. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('impersonation/exit')
  async exitImpersonation(@Req() request: Request) {
    const session = await this.requireMutableSession(request);
    const restored = this.authService.exitImpersonation(session.user);
    session.user = restored;
    await this.sessionService.save(session);
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
    await this.authService.resetPassword(body.token, body.password);
    return { ok: true };
  }

  private callbackUrl(request: Request) {
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
