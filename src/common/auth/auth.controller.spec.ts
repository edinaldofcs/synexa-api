import { AuthController } from './auth.controller';
import { Request } from 'express';

describe('AuthController', () => {
  const authService = {
    login: jest.fn(),
    requestMagicLink: jest.fn(),
    completeMagicLink: jest.fn(),
  };
  const sessionService = {
    create: jest.fn(),
    get: jest.fn(),
    destroy: jest.fn(),
    destroyAllForUser: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'ENVIRONMENT') return 'development';
      return fallback;
    }),
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates a session and does not return an access token', async () => {
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      role: 'platform_admin',
      company_id: 'company-1',
    };
    const session = { id: 'session-id', csrfToken: 'csrf-token' };
    authService.login.mockResolvedValue(user);
    sessionService.create.mockResolvedValue(session);
    const response = { cookie: jest.fn() };
    const controller = new AuthController(
      authService as any,
      sessionService as any,
      configService as any,
    );

    const result = await controller.login(
      { email: user.email, password: 'password' },
      response as any,
      { ip: '127.0.0.1' } as any,
    );

    expect(result).toEqual({ user });
    expect(result).not.toHaveProperty('access_token');
    expect(response.cookie).toHaveBeenCalledTimes(2);
  });

  it('exchanges the magic-link proof for HttpOnly application cookies', async () => {
    const user = { id: 'user', company_id: 'company' };
    authService.completeMagicLink.mockResolvedValue(user);
    sessionService.create.mockResolvedValue({
      id: 'session',
      csrfToken: 'csrf',
    });
    const response = { cookie: jest.fn() };
    const controller = new AuthController(
      authService as never,
      sessionService as never,
      configService as never,
    );
    await expect(
      controller.completeMagicLink({ token: 'proof' }, response as never),
    ).resolves.toEqual({ user });
    expect(authService.completeMagicLink).toHaveBeenCalledWith('proof');
    expect(response.cookie).toHaveBeenCalledWith(
      'synexa_session',
      'session',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('redirects legacy callback URLs to the browser callback', () => {
    const controller = new AuthController(
      authService as never,
      sessionService as never,
      { get: () => 'https://example.test' } as never,
    );
    const response = { redirect: jest.fn() };
    controller.callback(response as never);
    expect(response.redirect).toHaveBeenCalledWith(
      'https://example.test/auth/callback',
    );
  });
});

describe('AuthController - callbackUrl (host header injection)', () => {
  const build = (config: Record<string, any>) => {
    const configService = {
      get: (key: string, def?: any) => (key in config ? config[key] : def),
    };
    return new AuthController({} as any, {} as any, configService as any);
  };

  const mockRequest = (host: string): Request =>
    ({
      protocol: 'https',
      get: (key: string) => (key === 'host' ? host : undefined),
    }) as unknown as Request;

  it('usa AUTH_CALLBACK_URL configurada', () => {
    const controller = build({
      AUTH_CALLBACK_URL: 'https://painel.exemplo.com/api/auth/callback',
    });
    expect(
      (controller as any).callbackUrl(mockRequest('evil.example.com')),
    ).toBe('https://painel.exemplo.com/api/auth/callback');
  });

  it('prioriza a página do frontend para receber o fragmento do Supabase', () => {
    const controller = build({
      AUTH_FRONTEND_URL: 'https://app.exemplo.com/',
      AUTH_CALLBACK_URL: 'https://app.exemplo.com/api/auth/callback',
    });
    expect(
      (controller as any).callbackUrl(mockRequest('evil.example.com')),
    ).toBe('https://app.exemplo.com/auth/callback');
  });

  it('deriva de CORS_ORIGIN quando AUTH_CALLBACK_URL ausente', () => {
    const controller = build({ CORS_ORIGIN: 'https://app.exemplo.com' });
    expect(
      (controller as any).callbackUrl(mockRequest('evil.example.com')),
    ).toBe('https://app.exemplo.com/api/auth/callback');
  });

  it('usa a primeira origem de CORS_ORIGIN multi-valor', () => {
    const controller = build({
      CORS_ORIGIN: 'https://app.exemplo.com, https://outro.exemplo.com',
    });
    expect(
      (controller as any).callbackUrl(mockRequest('evil.example.com')),
    ).toBe('https://app.exemplo.com/api/auth/callback');
  });

  it('só usa o header Host em development (fallback legado)', () => {
    const controller = build({
      ENVIRONMENT: 'development',
      CORS_ORIGIN: '',
    });
    expect((controller as any).callbackUrl(mockRequest('localhost:5173'))).toBe(
      'https://localhost:5173/api/auth/callback',
    );
  });

  it('falha em produção sem AUTH_CALLBACK_URL nem CORS_ORIGIN (não usa Host)', () => {
    const controller = build({
      ENVIRONMENT: 'production',
      CORS_ORIGIN: '',
    });
    expect(() =>
      (controller as any).callbackUrl(mockRequest('evil.example.com')),
    ).toThrow(/AUTH_CALLBACK_URL/);
  });
});
