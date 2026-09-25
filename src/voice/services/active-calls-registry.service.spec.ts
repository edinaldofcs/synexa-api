import { Test, TestingModule } from '@nestjs/testing';
import { ActiveCallsRegistryService } from './active-calls-registry.service';
import { RedisService } from '../../common/redis/redis.service';

describe('ActiveCallsRegistryService', () => {
  let service: ActiveCallsRegistryService;
  let redisServiceMock: any;

  beforeEach(async () => {
    redisServiceMock = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActiveCallsRegistryService,
        {
          provide: RedisService,
          useValue: redisServiceMock,
        },
      ],
    }).compile();

    service = module.get<ActiveCallsRegistryService>(ActiveCallsRegistryService);
  });

  it('deve registrar e recuperar uma chamada ativa', async () => {
    await service.registerCall({
      callId: 'call-123',
      channelId: 'chan-1',
      companyId: 'comp-1',
      clientId: 'cli-1',
      callerNumber: '+5511999998888',
      callerName: 'Cliente Teste',
      didNumber: '2000',
    });

    const activeCalls = await service.getActiveCalls('comp-1');
    expect(activeCalls).toHaveLength(1);
    expect(activeCalls[0].callId).toBe('call-123');
    expect(activeCalls[0].callerNumber).toBe('+5511999998888');
    expect(activeCalls[0].status).toBe('connecting');
    expect(activeCalls[0].companyId).toBe('comp-1');
  });

  it('deve atualizar o status de fala da chamada', async () => {
    await service.registerCall({
      callId: 'call-123',
      channelId: 'chan-1',
      companyId: 'comp-1',
      clientId: 'cli-1',
      callerNumber: '+5511999998888',
      callerName: 'Cliente Teste',
      didNumber: '2000',
    });

    service.updateCallStatus('call-123', 'listening_user');
    const call = service.getCall('call-123');
    expect(call?.status).toBe('listening_user');
  });

  it('deve desregistrar a chamada corretamente', async () => {
    await service.registerCall({
      callId: 'call-123',
      channelId: 'chan-1',
      companyId: 'comp-1',
      clientId: 'cli-1',
      callerNumber: '+5511999998888',
      callerName: 'Cliente Teste',
      didNumber: '2000',
    });

    await service.unregisterCall('call-123');
    expect(await service.getActiveCalls('comp-1')).toHaveLength(0);
    expect(service.getCall('call-123')).toBeUndefined();
  });

  it('deve transmitir chunks de audio para listeners cadastrados', async () => {
    await service.registerCall({
      callId: 'call-123',
      channelId: 'chan-1',
      companyId: 'comp-1',
      clientId: 'cli-1',
      callerNumber: '+5511999998888',
      callerName: 'Cliente Teste',
      didNumber: '2000',
    });

    const listenerMock = jest.fn();
    const unsubscribe = service.subscribeAudio('call-123', listenerMock);

    const testChunk = Buffer.from([1, 2, 3, 4]);
    service.pushAudioChunk('call-123', 'ai', testChunk, 24000);

    expect(listenerMock).toHaveBeenCalledWith({
      role: 'ai',
      pcmBase64: testChunk.toString('base64'),
      sampleRate: 24000,
    });

    // Cancelar escuta
    unsubscribe();
    service.pushAudioChunk('call-123', 'user', testChunk, 16000);
    expect(listenerMock).toHaveBeenCalledTimes(1);
  });
});
