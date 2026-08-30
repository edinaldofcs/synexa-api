import { Test, TestingModule } from '@nestjs/testing';
import { ProviderCircuitBreakerService } from './circuit-breaker.service';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('ProviderCircuitBreakerService', () => {
  let service: ProviderCircuitBreakerService;
  let redisService: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    acquireLock: jest.Mock;
  };
  let prisma: {
    provider_credentials: {
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    redisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      acquireLock: jest.fn().mockResolvedValue(true),
    };
    prisma = {
      provider_credentials: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderCircuitBreakerService,
        {
          provide: RedisService,
          useValue: redisService,
        },
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<ProviderCircuitBreakerService>(
      ProviderCircuitBreakerService,
    );
  });

  it('inicia no estado CLOSED e permite execução', async () => {
    const canExec = await service.canExecute('groq', 'client-1');
    expect(canExec).toBe(true);
  });

  it('abre o circuito após 3 falhas consecutivas', async () => {
    await service.recordFailure('groq', new Error('500 Error'), 'client-1');
    await service.recordFailure('groq', new Error('500 Error'), 'client-1');
    expect(await service.canExecute('groq', 'client-1')).toBe(true);

    await service.recordFailure('groq', new Error('500 Error'), 'client-1');
    const state = await service.getState('groq', 'client-1');
    expect(state.state).toBe('OPEN');
    expect(await service.canExecute('groq', 'client-1')).toBe(false);
  });

  it('abre o circuito imediatamente em caso de 429 Rate Limit', async () => {
    await service.recordFailure(
      'groq',
      new Error('429 Rate limit exceeded'),
      'client-1',
    );
    const state = await service.getState('groq', 'client-1');
    expect(state.state).toBe('OPEN');
    expect(await service.canExecute('groq', 'client-1')).toBe(false);
  });

  it('fecha o circuito ao registrar sucesso', async () => {
    await service.recordFailure(
      'groq',
      new Error('429 Rate limit'),
      'client-1',
    );
    expect(await service.canExecute('groq', 'client-1')).toBe(false);

    await service.recordSuccess('groq', 'client-1');
    expect(await service.canExecute('groq', 'client-1')).toBe(true);
    const state = await service.getState('groq', 'client-1');
    expect(state.state).toBe('CLOSED');
  });

  it('não persiste nem atualiza saúde em recordSuccess com CLOSED estável', async () => {
    await service.recordSuccess('groq', 'client-1');

    expect(redisService.set).not.toHaveBeenCalled();
    expect(prisma.provider_credentials.updateMany).not.toHaveBeenCalled();
  });

  it('persiste somente na transição de estado ao abrir o circuito', async () => {
    await service.recordFailure('groq', new Error('500'), 'client-1');
    await service.recordFailure('groq', new Error('500'), 'client-1');
    expect(redisService.set).not.toHaveBeenCalled();
    expect(prisma.provider_credentials.updateMany).not.toHaveBeenCalled();

    await service.recordFailure('groq', new Error('500'), 'client-1');
    expect(redisService.set).toHaveBeenCalledTimes(1);
    expect(prisma.provider_credentials.updateMany).toHaveBeenCalledTimes(1);
  });

  it('transição lazy OPEN→HALF_OPEN é persistida no Redis', async () => {
    await service.recordFailure('groq', new Error('429 Rate limit'), 'client-1');
    const key = (service as any).getCircuitKey('groq', 'client-1');
    const info = (service as any).inMemoryState.get(key);
    info.nextAttemptTime = Date.now() - 1;

    const state = await service.getState('groq', 'client-1');
    expect(state.state).toBe('HALF_OPEN');
    expect(redisService.set).toHaveBeenCalledWith(
      'circuit:client-1:groq',
      expect.objectContaining({ state: 'HALF_OPEN' }),
    );
  });

  it('HALF_OPEN concede probe única via SETNX e rejeita os demais', async () => {
    await service.recordFailure('groq', new Error('429 Rate limit'), 'client-1');
    const key = (service as any).getCircuitKey('groq', 'client-1');
    (service as any).inMemoryState.get(key).nextAttemptTime = Date.now() - 1;

    redisService.acquireLock.mockResolvedValueOnce(true);
    expect(await service.canExecute('groq', 'client-1')).toBe(true);
    expect(redisService.acquireLock).toHaveBeenCalledWith(
      'cb:probe:circuit:client-1:groq',
      10,
    );

    redisService.acquireLock.mockResolvedValueOnce(false);
    expect(await service.canExecute('groq', 'client-1')).toBe(false);
  });

  it('recordSuccess em HALF_OPEN persiste, libera probe e fecha o circuito', async () => {
    await service.recordFailure('groq', new Error('429 Rate limit'), 'client-1');
    const key = (service as any).getCircuitKey('groq', 'client-1');
    (service as any).inMemoryState.get(key).nextAttemptTime = Date.now() - 1;

    redisService.set.mockClear();
    redisService.acquireLock.mockResolvedValue(true);
    expect(await service.canExecute('groq', 'client-1')).toBe(true);

    await service.recordSuccess('groq', 'client-1');

    const state = await service.getState('groq', 'client-1');
    expect(state.state).toBe('CLOSED');
    expect(redisService.set).toHaveBeenCalledWith(
      'circuit:client-1:groq',
      expect.objectContaining({ state: 'CLOSED', consecutiveFailures: 0 }),
    );
    expect(redisService.del).toHaveBeenCalledWith(
      'cb:probe:circuit:client-1:groq',
    );
    expect(prisma.provider_credentials.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { client_id: 'client-1', provider: 'groq' },
      }),
    );
  });
});
