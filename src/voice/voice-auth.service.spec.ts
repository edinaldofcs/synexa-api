import { UnauthorizedException } from '@nestjs/common';
import { VoiceAuthService } from './voice-auth.service';

describe('VoiceAuthService', () => {
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findFirst: jest.fn() },
  };
  const sessionService = { get: jest.fn() };
  let service: VoiceAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new VoiceAuthService(prisma as any, sessionService as any);
  });

  it('rejects a connection without a session id', async () => {
    await expect(service.authenticateSession('')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionService.get).toHaveBeenCalledWith('');
  });

  it('loads the company from the authenticated session user', async () => {
    sessionService.get.mockResolvedValue({ user: { id: 'user-1' } });
    prisma.users.findUnique.mockResolvedValue({
      id: 'user-1',
      company_id: 'company-1',
      role: 'operator',
      companies: { status: 'active' },
    });

    await expect(service.authenticateSession('valid-session')).resolves.toEqual(
      {
        id: 'user-1',
        company_id: 'company-1',
        role: 'operator',
      },
    );
  });

  it('rejects a client outside the authenticated company', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveClientId('company-1', 'client-from-other-company'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('resolves the first client when no client was selected', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue({ id: 'client-1' });

    await expect(service.resolveClientId('company-1')).resolves.toBe(
      'client-1',
    );
  });
});
