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
});
