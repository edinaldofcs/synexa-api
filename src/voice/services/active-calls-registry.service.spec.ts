import { Test, TestingModule } from '@nestjs/testing';
import { ActiveCallsRegistryService } from './active-calls-registry.service';
import { RedisService } from '../../common/redis/redis.service';

describe('ActiveCallsRegistryService', () => {
  let service: ActiveCallsRegistryService;
  let redisServiceMock: any;

  beforeEach(async () => {
    const cache = new Map<string, string>();
    redisServiceMock = {
      set: jest.fn().mockImplementation(async (key: string, value: unknown) => {
        cache.set(key, JSON.stringify(value));
      }),
      get: jest.fn().mockImplementation(async (key: string) => {
        const value = cache.get(key);
        return value === undefined ? null : JSON.parse(value);
      }),
      del: jest
        .fn()
        .mockImplementation(async (key: string) => cache.delete(key)),
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

    service = module.get<ActiveCallsRegistryService>(
      ActiveCallsRegistryService,
    );
  });

  const descriptor = {
    callId: 'call-123',
    channelId: 'chan-1',
    companyId: 'comp-1',
    clientId: 'cli-1',
    callerNumber: '+5511999998888',
    callerName: 'Cliente Teste',
    didNumber: '2000',
  };

  it('publica uma lista serializável e sem duplicar o alias do canal', async () => {
    const call = await service.registerCall(descriptor);
    const apiRegistry = new ActiveCallsRegistryService(redisServiceMock);

    expect(await apiRegistry.getActiveCalls('comp-1')).toEqual([call]);
    expect(await apiRegistry.getCallFromRedis(call.callId)).toEqual(call);
  });

  it('publica somente chamadas da empresa consultada', async () => {
    const call = await service.registerCall(descriptor);
    const otherCall = await service.registerCall({
      ...descriptor,
      callId: 'call-other',
      channelId: 'chan-other',
      companyId: 'comp-other',
      clientId: 'cli-other',
    });
    const apiRegistry = new ActiveCallsRegistryService(redisServiceMock);

    expect(await apiRegistry.getActiveCalls('comp-1')).toEqual([call]);
    expect(await apiRegistry.getActiveCalls('comp-other')).toEqual([otherCall]);
    expect(await apiRegistry.getActiveCalls('comp-empty')).toEqual([]);
  });

  it('remove a última chamada sem republicar a lista antiga do Redis', async () => {
    const call = await service.registerCall(descriptor);
    // Simula uma lista válida já publicada por uma instância anterior.
    await redisServiceMock.set('synexa:active_calls:comp-1', [call], 3600);
    const apiRegistry = new ActiveCallsRegistryService(redisServiceMock);
    expect(await apiRegistry.getActiveCalls('comp-1')).toEqual([call]);

    await service.unregisterCall(call.channelId);

    expect(await apiRegistry.getActiveCalls('comp-1')).toEqual([]);
    expect(await apiRegistry.getCallFromRedis(call.callId)).toBeUndefined();
    expect(await service.getActiveCalls('comp-1')).toEqual([]);
    expect(service.getCall(call.channelId)).toBeUndefined();
  });

  it('preserva as outras chamadas ao remover uma chamada da empresa', async () => {
    await service.registerCall(descriptor);
    const remaining = await service.registerCall({
      ...descriptor,
      callId: 'call-456',
      channelId: 'chan-2',
    });

    await service.unregisterCall(descriptor.callId);

    const apiRegistry = new ActiveCallsRegistryService(redisServiceMock);
    expect(await apiRegistry.getActiveCalls('comp-1')).toEqual([remaining]);
  });

  it('mantém o registro local quando o Redis está indisponível', async () => {
    redisServiceMock.set.mockRejectedValue(new Error('Redis unavailable'));
    const call = await service.registerCall(descriptor);
    expect(await service.getActiveCalls('comp-1')).toEqual([call]);

    redisServiceMock.del.mockRejectedValue(new Error('Redis unavailable'));
    redisServiceMock.get.mockRejectedValue(new Error('Redis unavailable'));
    await service.unregisterCall(call.callId);
    expect(await service.getActiveCalls('comp-1')).toEqual([]);
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
