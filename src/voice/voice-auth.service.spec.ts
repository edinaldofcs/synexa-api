import { UnauthorizedException } from '@nestjs/common';
import { VoiceAuthService } from './voice-auth.service';

describe('VoiceAuthService', () => {
  const configService = {
    get: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
  };
  const prisma = {
    users: {
      findUnique: jest.fn(),
    },
    painel_clients: {
      findFirst: jest.fn(),
    },
  };

  let service: VoiceAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new VoiceAuthService(configService as any, jwtService as any, prisma as any);
    configService.get.mockImplementation((key: string, fallback?: unknown) => {
      if (key === 'ENVIRONMENT') return 'development';
      if (key === 'JWT_SECRET') return 'local-secret';
      return fallback;
    });
  });

  it('rejects a session without an access token', async () => {
    await expect(service.authenticate('')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects invalid local tokens', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid token'));

    await expect(service.authenticate('invalid-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('loads the company from the authenticated database user', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    prisma.users.findUnique.mockResolvedValue({
      id: 'user-1',
      company_id: 'company-1',
      role: 'operator',
    });

    await expect(service.authenticate('valid-token')).resolves.toEqual({
      id: 'user-1',
      company_id: 'company-1',
      role: 'operator',
    });
    expect(prisma.users.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, company_id: true, role: true },
    });
  });

  it('rejects a client outside the authenticated company', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveClientId('company-1', 'client-from-other-company'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.painel_clients.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'client-from-other-company',
        company_id: 'company-1',
      },
      select: { id: true },
    });
  });

  it('resolves the first active client when no client was selected', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue({ id: 'client-1' });

    await expect(service.resolveClientId('company-1')).resolves.toBe('client-1');
    expect(prisma.painel_clients.findFirst).toHaveBeenCalledWith({
      where: { company_id: 'company-1', status: 'active' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  });
});
