import { createClient } from '@supabase/supabase-js';
import { AuthService } from './auth.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

describe('AuthService email links', () => {
  const user = {
    id: 'user',
    email: 'user@example.test',
    company_id: 'company',
    companies: { status: 'active' },
  };
  const auth = {
    getClaims: jest.fn(),
    getUser: jest.fn(),
    setSession: jest.fn(),
    updateUser: jest.fn(),
    signOut: jest.fn(),
    signInWithOtp: jest.fn(),
    resetPasswordForEmail: jest.fn(),
  };
  const redis = {
    acquireLock: jest.fn(),
    releaseLock: jest.fn(),
    checkRateLimit: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };
  const prisma = { users: { findUnique: jest.fn(), update: jest.fn() } };
  const sessions = { destroyAllForUser: jest.fn() };
  let service: AuthService;
  function claims(method = 'recovery', age = 0) {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: user.id,
          session_id: 'recovery-session',
          amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - age }],
        },
      },
      error: null,
    });
  }
  beforeEach(() => {
    jest.resetAllMocks();
    (createClient as jest.Mock).mockReturnValue({ auth });
    claims();
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.setSession.mockResolvedValue({ data: { user }, error: null });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.signOut.mockResolvedValue({ error: null });
    auth.signInWithOtp.mockResolvedValue({ error: null });
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    redis.acquireLock.mockResolvedValue(true);
    redis.checkRateLimit.mockResolvedValue({ allowed: true });
    prisma.users.findUnique.mockResolvedValue(user);
    const config = {
      get: (key: string) => (key === 'AUTH_PROVIDER' ? 'supabase' : 'test'),
    };
    service = new AuthService(
      prisma as never,
      config as never,
      redis as never,
      {} as never,
      sessions as never,
    );
  });
  it('updates the Supabase password and revokes sessions without writing a local password', async () => {
    await service.resetPassword(
      'access-token',
      'New-password123',
      'refresh-token',
    );
    expect(auth.getClaims).toHaveBeenCalledWith('access-token');
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    expect(auth.updateUser).toHaveBeenCalledWith({
      password: 'New-password123',
    });
    expect(prisma.users.update).not.toHaveBeenCalled();
    expect(sessions.destroyAllForUser).toHaveBeenCalledWith(user.id);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });
  it.each(['password', 'magiclink', 'invite'])(
    'rejects %s tokens for password recovery',
    async (method) => {
      claims(method);
      await expect(
        service.resetPassword('access', 'Password123', 'refresh'),
      ).rejects.toThrow('Link inválido');
      expect(auth.updateUser).not.toHaveBeenCalled();
    },
  );
  it('rejects forged or expired tokens', async () => {
    auth.getClaims.mockResolvedValue({
      data: null,
      error: { message: 'invalid signature' },
    });
    await expect(
      service.resetPassword('forged', 'Password123', 'refresh'),
    ).rejects.toThrow('Link inválido');
    expect(auth.setSession).not.toHaveBeenCalled();
  });
  it('rejects recovery credentials older than the replay protection window', async () => {
    claims('recovery', 3601);
    await expect(
      service.resetPassword('access', 'Password123', 'refresh'),
    ).rejects.toThrow('Link inválido');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('rejects a missing refresh token', async () => {
    await expect(
      service.resetPassword('access', 'Password123'),
    ).rejects.toThrow('Link incompleto');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('rejects a disabled or pending user', async () => {
    prisma.users.findUnique.mockResolvedValue({
      ...user,
      invitation_pending: true,
    });
    await expect(
      service.resetPassword('access', 'Password123', 'refresh'),
    ).rejects.toThrow('Usuário não autorizado');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('blocks concurrent requests and reused recovery sessions', async () => {
    redis.acquireLock.mockResolvedValueOnce(true).mockResolvedValue(false);
    await service.resetPassword('access', 'Password123', 'refresh');
    await expect(
      service.resetPassword('refreshed-access', 'Password456', 'refresh'),
    ).rejects.toThrow('já utilizado');
    expect(auth.updateUser).toHaveBeenCalledTimes(1);
  });
  it('allows retry after a rejected password without leaking provider details', async () => {
    auth.updateUser.mockResolvedValue({
      error: { code: 'same_password', message: 'internal detail' },
    });
    await expect(
      service.resetPassword('access', 'Password123', 'refresh'),
    ).rejects.toThrow('Escolha uma senha diferente');
    expect(redis.releaseLock).toHaveBeenCalled();
    expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
  });
  it('completes a magic link and consumes it once', async () => {
    claims('magiclink');
    await expect(service.completeMagicLink('access')).resolves.toMatchObject({
      id: user.id,
    });
    expect(auth.getUser).toHaveBeenCalledWith('access');
    redis.acquireLock.mockResolvedValue(false);
    await expect(service.completeMagicLink('access')).rejects.toThrow(
      'já utilizado',
    );
  });

  it('accepts the OTP authentication method emitted by real implicit magic links', async () => {
    claims('otp');
    await expect(
      service.completeMagicLink('signed-otp-access'),
    ).resolves.toMatchObject({ id: user.id });
    expect(auth.getUser).toHaveBeenCalledWith('signed-otp-access');
  });

  it('accepts the OTP authentication method emitted by real implicit recovery links', async () => {
    claims('otp');
    await service.resetPassword('signed-otp-access', 'Password123', 'refresh');
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'Password123' });
  });

  it('does not reuse an OTP session across login and password recovery', async () => {
    claims('otp');
    const consumed = new Set<string>();
    redis.acquireLock.mockImplementation(async (key: string) => {
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    });
    await service.completeMagicLink('signed-otp-access');
    await expect(
      service.resetPassword('signed-otp-access', 'Password123', 'refresh'),
    ).rejects.toThrow('já utilizado');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects an old OTP proof instead of accepting any OTP session', async () => {
    claims('otp', 3601);
    await expect(service.completeMagicLink('old-otp-access')).rejects.toThrow(
      'Link inválido',
    );
    expect(auth.getUser).not.toHaveBeenCalled();
  });
  it('does not turn a recovery credential into a login session', async () => {
    await expect(service.completeMagicLink('access')).rejects.toThrow(
      'Link inválido',
    );
  });
  it('requests magic links without creating new accounts', async () => {
    await service.requestMagicLink(
      user.email,
      'https://example.test/auth/callback',
    );
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: user.email,
      options: {
        emailRedirectTo: 'https://example.test/auth/callback',
        shouldCreateUser: false,
      },
    });
  });
  it('keeps the password recovery redirect on the configured frontend', async () => {
    await service.requestPasswordReset(
      user.email,
      'https://example.test/reset-password',
    );
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(user.email, {
      redirectTo: 'https://example.test/reset-password',
    });
  });
  it('preserves local password reset without contacting Supabase', async () => {
    service = new AuthService(
      prisma as never,
      { get: () => 'local' } as never,
      redis as never,
      {} as never,
      sessions as never,
    );
    redis.get.mockResolvedValue('local-user');
    await service.resetPassword('local-token', 'Password123');
    expect(prisma.users.update).toHaveBeenCalledWith({
      where: { id: 'local-user' },
      data: { password_hash: expect.any(String) },
    });
    expect(redis.del).toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});
