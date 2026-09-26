import { SipAccessService } from './sip-access.service';
import { TelephonyEndpointResolverService } from '../voice/services/telephony-endpoint-resolver.service';
import { createHash } from 'crypto';

describe('Individual SIP access', () => {
  const user = { id: 'user', role: 'company_admin', company_id: 'company' };
  let prisma: any;
  let service: SipAccessService;
  beforeEach(() => {
    prisma = {
      painel_clients: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'client', company_id: 'company' }),
      },
      sip_accounts: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new SipAccessService(prisma, {
      get: () => 'sip.example.com',
    } as any);
  });
  it('rejects operators before reading credentials', async () => {
    await expect(
      service.generate({ ...user, role: 'operator' }, 'client'),
    ).rejects.toThrow('Acesso negado');
    expect(prisma.sip_accounts.findUnique).not.toHaveBeenCalled();
  });
  it('scopes client lookup and denies other companies before reading or writing accounts', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue(null);
    for (const action of [
      () => service.get(user, 'foreign'),
      () => service.generate(user, 'foreign'),
      () => service.revoke(user, 'foreign'),
    ])
      await expect(action()).rejects.toThrow('Cliente não encontrado');
    expect(prisma.painel_clients.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'foreign',
          company_id: 'company',
          companies: { status: 'active' },
        },
      }),
    );
    expect(prisma.sip_accounts.findUnique).not.toHaveBeenCalled();
    expect(prisma.sip_accounts.updateMany).not.toHaveBeenCalled();
  });
  it('returns a random password once and only persists SIP HA1', async () => {
    const result = await service.generate(user, 'client');
    expect(result.password).toHaveLength(32);
    expect(result.account.username).toMatch(/^sx_[a-f0-9]{24}$/);
    const { data } = prisma.sip_accounts.create.mock.calls[0][0];
    expect(data.digest).toBe(
      createHash('md5')
        .update(`${result.account.username}:asterisk:${result.password}`)
        .digest('hex'),
    );
    expect(data).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('digest');
  });
  it('never selects authentication material on GET', async () => {
    await service.get(user, 'client');
    expect(prisma.sip_accounts.findUnique).toHaveBeenCalledWith({
      where: { client_id: 'client' },
      select: { username: true, enabled: true, updated_at: true },
    });
  });
  it('duplicate create does not silently rotate an existing password', async () => {
    prisma.sip_accounts.findUnique.mockResolvedValue({ username: 'existing' });
    await expect(service.generate(user, 'client')).rejects.toThrow('já existe');
    expect(prisma.sip_accounts.update).not.toHaveBeenCalled();
  });
  it('handles competing account creation as conflict', async () => {
    prisma.sip_accounts.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.generate(user, 'client')).rejects.toThrow('já criado');
  });
  it('rotation preserves username, changes digest and reactivates a revoked account', async () => {
    prisma.sip_accounts.findUnique.mockResolvedValue({ username: 'sx_123' });
    const first = await service.generate(user, 'client', true);
    const second = await service.generate(user, 'client', true);
    expect(first.account.username).toBe('sx_123');
    expect(first.password).not.toBe(second.password);
    expect(prisma.sip_accounts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      }),
    );
  });
  it('revocation is scoped and idempotent', async () => {
    await service.revoke(user, 'client');
    expect(prisma.sip_accounts.updateMany).toHaveBeenCalledWith({
      where: { client_id: 'client' },
      data: { enabled: false },
    });
  });
  it('voice fails closed without endpoint identity or a current account match', async () => {
    const resolver = new TelephonyEndpointResolverService(prisma, {} as any);
    const route = { client_id: 'client', company_id: 'company' } as any;
    expect(await resolver.authorizeSipEndpoint(undefined, route)).toBe(false);
    expect(await resolver.authorizeSipEndpoint('sx_123', route)).toBe(false);
    expect(prisma.sip_accounts.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          username: 'sx_123',
          client_id: 'client',
          company_id: 'company',
          enabled: true,
          companies: { status: 'active' },
        }),
      }),
    );
    prisma.sip_accounts.findFirst.mockResolvedValue({ id: 'account' });
    expect(await resolver.authorizeSipEndpoint('sx_123', route)).toBe(true);
    expect(await resolver.authorizeSipEndpoint('microsip', route)).toBe(true);
  });
});
