import { AuthController } from './auth.controller';

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
      role: 'admin',
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
    );

    expect(result).toEqual({ user });
    expect(result).not.toHaveProperty('access_token');
    expect(response.cookie).toHaveBeenCalledTimes(2);
  });
});
