import { HandoffDistributorService } from './handoff-distributor.service';

describe('HandoffDistributorService - corrida na distribuição', () => {
  const build = () => {
    const prisma = {
      conversations: {
        count: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      users: { findMany: jest.fn() },
      painel_clients: { findUnique: jest.fn().mockResolvedValue(null) },
      message_events: { create: jest.fn().mockResolvedValue({}) },
    };
    const redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    const presence = {
      listAvailable: jest.fn().mockResolvedValue(['op-1', 'op-2']),
      isOnline: jest.fn().mockResolvedValue(true),
      getLastSeen: jest.fn().mockResolvedValue(Date.now()),
    };
    const service = new HandoffDistributorService(
      prisma as never,
      redis as never,
      presence as never,
    );
    return { prisma, redis, presence, service };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serializa a distribuição por empresa com lock Redis', async () => {
    const { prisma, redis, presence, service } = build();
    prisma.users.findMany.mockResolvedValue([
      { id: 'op-1', name: 'Op 1' },
      { id: 'op-2', name: 'Op 2' },
    ]);
    prisma.conversations.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);

    const result = await service.distribute('conv-1', 'company-1', null);

    expect(redis.acquireLock).toHaveBeenCalledWith(
      'handoff:distribute:company-1',
      10,
    );
    expect(redis.releaseLock).toHaveBeenCalled();
    expect(result).toBe('op-1');
    expect(presence.listAvailable).toHaveBeenCalled();
  });

  it('retorna null e mantém conversa na fila quando outro processo já distribui', async () => {
    const { prisma, redis, presence, service } = build();
    redis.acquireLock.mockResolvedValue(false);

    const result = await service.distribute('conv-1', 'company-1', null);

    expect(result).toBeNull();
    expect(presence.listAvailable).not.toHaveBeenCalled();
    expect(prisma.conversations.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'conv-1',
          assigned_to: null,
        }),
      }),
    );
  });

  it('usa updateMany condicional (não sobrescreve atribuição concorrente)', async () => {
    const { prisma, service } = build();
    prisma.users.findMany.mockResolvedValue([{ id: 'op-1', name: 'Op 1' }]);
    prisma.conversations.count.mockResolvedValue(0);
    prisma.conversations.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.distribute('conv-1', 'company-1', null);

    expect(prisma.conversations.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'conv-1',
          assigned_to: null,
        }),
      }),
    );
    // mesmo assim informa o operador escolhido (a conversa foi atribuída por outro fluxo)
    expect(result).toBe('op-1');
  });

  it('sem operadores disponíveis: marca conversa como não atribuída de forma condicional', async () => {
    const { prisma, redis, presence, service } = build();
    presence.listAvailable.mockResolvedValue([]);

    const result = await service.distribute('conv-1', 'company-1', null);

    expect(result).toBeNull();
    expect(redis.releaseLock).toHaveBeenCalled();
    expect(prisma.conversations.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'conv-1',
          assigned_to: null,
        }),
      }),
    );
  });
});
