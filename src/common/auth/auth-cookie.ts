import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { ConfigService } from '@nestjs/config';

type CookieRequest = { headers: { cookie?: string } };

export const SESSION_COOKIE = 'synexa_session';
export const CSRF_COOKIE = 'synexa_csrf';

export type AuthCookieSameSite = 'lax' | 'strict' | 'none';

function cookieOptions(configService: ConfigService) {
  const environment = configService.get<string>('ENVIRONMENT', 'development');
  const sameSite = configService.get<AuthCookieSameSite>(
    'AUTH_COOKIE_SAME_SITE',
    environment === 'development' ? 'lax' : 'lax',
  );

  return {
    path: '/',
    secure: environment !== 'development',
    sameSite,
  } as const;
}

export function setAuthCookies(
  response: Response,
  configService: ConfigService,
  sessionId: string,
  csrfToken: string,
  maxAgeMs: number,
) {
  const options = cookieOptions(configService);

  response.cookie(SESSION_COOKIE, sessionId, {
    ...options,
    httpOnly: true,
    maxAge: maxAgeMs,
  });
  response.cookie(CSRF_COOKIE, csrfToken, {
    ...options,
    httpOnly: false,
    maxAge: maxAgeMs,
  });
}

export function clearAuthCookies(
  response: Response,
  configService: ConfigService,
) {
  const options = cookieOptions(configService);
  response.clearCookie(SESSION_COOKIE, options);
  response.clearCookie(CSRF_COOKIE, options);
}

export function readCookie(
  request: CookieRequest,
  name: string,
): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

export function getSessionId(request: CookieRequest): string | null {
  return readCookie(request, SESSION_COOKIE);
}

function valuesMatch(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function hasValidCsrfToken(request: Request, expectedToken: string) {
  const header = request.headers['x-csrf-token'];
  const headerToken = Array.isArray(header) ? header[0] : header;
  return (
    valuesMatch(readCookie(request, CSRF_COOKIE), headerToken ?? null) &&
    valuesMatch(headerToken ?? null, expectedToken)
  );
}

export function hasTrustedOrigin(
  request: Request,
  configService: ConfigService,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;

  const environment = configService.get<string>('ENVIRONMENT', 'development');
  if (environment === 'development' || environment === 'test') return true;

  const configuredOrigins = (configService.get<string>('CORS_ORIGIN') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configuredOrigins.includes(origin);
}
