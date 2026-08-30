import { SessionService, type SessionUser } from './session.service';

describe('SessionService', () => {
  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    addToSet: jest.fn(),
    expire: jest.fn(),
    removeFromSet: jest.fn(),
    getSetMembers: jest.fn(),
  };
  const user: SessionUser = {
    id: 'user-1',
    email: 'user@example.com',
    role: 'operator',
    company_id: 'company-1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates a random server-side session with CSRF token', async () => {
    const service = new SessionService(redis as any);
    const session = await service.create(user);

    expect(session.id).toHaveLength(43);
    expect(session.csrfToken).toHaveLength(43);
    expect(redis.set).toHaveBeenCalledWith(
      `auth:session:${session.id}`,
      session,
      24 * 60 * 60,
    );
    expect(redis.addToSet).toHaveBeenCalledWith(
      `auth:user-sessions:${user.id}`,
      session.id,
    );
  });

  it('removes expired sessions', async () => {
    const service = new SessionService(redis as any);
    redis.get.mockResolvedValue({
      id: 'expired',
      user,
      csrfToken: 'csrf',
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 1,
    });

    await expect(service.get('expired')).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith('auth:session:expired');
  });

  it('auto-exits expired impersonation and restores the original identity', async () => {
    const service = new SessionService(redis as any);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    redis.get.mockResolvedValue({
      id: 'session-1',
      user: {
        ...user,
        role: 'company_admin',
        company_id: 'company-2',
        company_name: 'Empresa Beta',
        original_role: 'platform_admin',
        original_company_id: 'company-1',
        original_company_name: 'Synexa Admin',
        impersonating_until: Date.now() - 1000,
      },
      csrfToken: 'csrf',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt,
    });

    const session = await service.get('session-1');

    expect(session?.user.role).toBe('platform_admin');
    expect(session?.user.company_id).toBe('company-1');
    expect(session?.user.company_name).toBe('Synexa Admin');
    expect(session?.user.impersonating_until).toBeUndefined();
    expect(redis.set).toHaveBeenCalledWith(
      'auth:session:session-1',
      session,
      expect.any(Number),
    );
  });
});
