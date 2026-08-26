import type { Request, Response } from 'express';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  hasTrustedOrigin,
  hasValidCsrfToken,
  setAuthCookies,
} from './auth-cookie';

describe('auth cookies', () => {
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'ENVIRONMENT') return 'development';
      if (key === 'AUTH_COOKIE_SAME_SITE') return 'lax';
      return fallback;
    }),
  };

  it('sets an HttpOnly session cookie and a readable CSRF cookie', () => {
    const response = { cookie: jest.fn() } as unknown as Response;

    setAuthCookies(
      response,
      configService as any,
      'session-id',
      'csrf-token',
      60_000,
    );

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      SESSION_COOKIE,
      'session-id',
      expect.objectContaining({ httpOnly: true, maxAge: 60_000 }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      CSRF_COOKIE,
      'csrf-token',
      expect.objectContaining({ httpOnly: false, maxAge: 60_000 }),
    );
  });

  it('requires the CSRF token to match the session and request cookie', () => {
    const request = {
      headers: {
        cookie: `${CSRF_COOKIE}=csrf-token`,
        'x-csrf-token': 'csrf-token',
      },
    } as unknown as Request;

    expect(hasValidCsrfToken(request, 'csrf-token')).toBe(true);
    expect(hasValidCsrfToken(request, 'different-token')).toBe(false);
  });

  it('rejects an origin outside the configured allowlist', () => {
    const request = {
      headers: { origin: 'https://attacker.example' },
    } as unknown as Request;
    const config = {
      get: jest.fn((key: string) =>
        key === 'ENVIRONMENT' ? 'production' : 'https://app.example',
      ),
    };

    expect(hasTrustedOrigin(request, config as any)).toBe(false);
  });
});
