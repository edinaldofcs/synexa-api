import { Test, TestingModule } from '@nestjs/testing';
import { ProviderCircuitBreakerService } from './circuit-breaker.service';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('ProviderCircuitBreakerService', () => {
  let service: ProviderCircuitBreakerService;
  let redisService: {
    get: jest.Mock;
    set: jest.Mock;
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
});
