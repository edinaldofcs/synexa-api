import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { VoiceGateway } from './voice.gateway';
import { GeminiLiveVoiceProvider } from './providers/gemini-live-voice.provider';
import { buildVoiceFarewellToolResponse } from './services/voice-runtime.util';

const sockets: FakeClientSocket[] = [];
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockImplementation(async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  }));
});
afterEach(async () => {
  jest.useRealTimers();
  for (const socket of sockets.splice(0))
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  await new Promise((resolve) => setImmediate(resolve));
  global.fetch = originalFetch;
});
class FakeClientSocket extends EventEmitter {
  constructor() {
    super();
    sockets.push(this);
  }
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  handshakeRequest?: any;
  close = jest.fn((code: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  });

  send(payload: string) {
    this.sent.push(payload);
  }
}

import { VoiceSessionFactory } from './services/voice-session.factory';

function makeGateway(
  config: Record<string, unknown> = {},
  redis?: any,
  voiceSessionFactory?: any,
  prismaService?: any,
  greetingCacheService?: any,
) {
  const voiceAuthService = {
    authenticateSession: jest
      .fn()
      .mockRejectedValue(new Error('session required')),
    resolveClientId: jest.fn(),
  };
  const redisService = redis ?? {
    getClient: () => ({
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    }),
  };
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: any) => config[key] ?? defaultValue,
    ),
  };
  const voiceService = {
    getDefaultModel: jest.fn().mockReturnValue('gemini-2.5-flash-lite'),
    getDefaultVoice: jest.fn().mockReturnValue('Aoede'),
  };
  const keyResolver = {
    resolveApiKey: jest.fn().mockResolvedValue(''),
  };
  const audioGateService = {
    createSession: jest.fn().mockReturnValue({
      processPcm16Chunk: jest.fn(),
      reset: jest.fn(),
      notifyAiSpeakingChanged: jest.fn(),
    }),
  };
  const cartesiaTtsService = {
    synthesizeStream: jest.fn(),
    createSession: jest.fn().mockReturnValue({
      sendText: jest.fn(),
      pushText: jest.fn(),
      finalizeContext: jest.fn(),
      cancelContext: jest.fn(),
      close: jest.fn(),
    }),
  };
  const groqWhisperSttService = {
    transcribeChunk: jest.fn(),
  };
  const sileroVadService = {
    createSession: jest.fn().mockReturnValue({
      processChunk: jest.fn(),
      reset: jest.fn(),
      destroy: jest.fn(),
    }),
  };

  const voiceToolsService = {
    getAgentTools: jest.fn().mockResolvedValue([]),
    getAgentSubagents: jest.fn().mockResolvedValue([]),
  };
  const nativeToolsService = {
    getDeclarations: jest.fn().mockReturnValue([]),
  };

  if (prismaService) {
    prismaService.$transaction ??= jest.fn(async (fn: any) =>
      fn(prismaService),
    );
    prismaService.webhook_endpoints ??= {
      findFirst: jest.fn().mockResolvedValue(null),
    };
    if (prismaService.conversations)
      prismaService.conversations.updateMany ??= jest
        .fn()
        .mockResolvedValue({ count: 1 });
  }
  const gateway = new VoiceGateway(
    voiceService as any,
    voiceAuthService as any,
    {} as any,
    audioGateService as any,
    voiceSessionFactory ?? ({} as any),
    configService as any,
    prismaService ?? ({} as any),
    voiceToolsService as any,
    nativeToolsService as any,
    {
      flushAiBuffer: jest.fn().mockResolvedValue(undefined),
      persistSessionTelemetry: jest.fn().mockResolvedValue(undefined),
      persistConversationState: jest.fn().mockResolvedValue(undefined),
      buildTelemetryPayload: jest.fn().mockReturnValue(null),
    } as any,
    redisService as any,
    cartesiaTtsService as any,
    groqWhisperSttService as any,
    { createSession: jest.fn() } as any,
    { transcribePcm: jest.fn() } as any,
    sileroVadService as any,
    keyResolver as any,
    greetingCacheService,
  );
  (gateway as any).companyQuota = {
    acquire: jest
      .fn()
      .mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) }),
  };
  return {
    gateway,
    voiceAuthService,
    configService,
    audioGateService,
  };
}

describe('VoiceGateway security', () => {
  it('keeps native Live audio continuous even when the client enabled the acoustic gate', async () => {
    const connect = jest
      .spyOn(GeminiLiveVoiceProvider.prototype, 'connect')
      .mockImplementation(() => undefined);
    try {
      const prisma = {
        painel_clients: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'bot',
            audio_gate_enabled: true,
            metadata: { voice_engine: 'live_api' },
          }),
        },
        painel_agents: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'agent', interaction_mode: 'voice' }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        conversations: {
          create: jest.fn().mockResolvedValue({ id: 'conversation' }),
        },
      };
      const { gateway, voiceAuthService, audioGateService } = makeGateway(
        { GEMINI_API_KEY: 'test-key' },
        undefined,
        undefined,
        prisma,
      );
      voiceAuthService.authenticateSession.mockResolvedValue({
        company_id: 'company',
      });
      voiceAuthService.resolveClientId.mockResolvedValue('bot');
      const socket = new FakeClientSocket();
      gateway.handleConnection(socket as any);
      socket.emit(
        'message',
        JSON.stringify({ type: 'start', clientId: 'bot' }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(audioGateService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, sampleRate: 16000 }),
      );
    } finally {
      connect.mockRestore();
    }
  });

  it.each(['socket-first', 'nest-first', 'flush-failure'])(
    'centraliza a desconexão e libera o slot uma vez: %s',
    async (order) => {
      jest.useFakeTimers();
      const factory = { releaseSession: jest.fn() };
      const { gateway } = makeGateway({}, undefined, factory);
      const client = new FakeClientSocket();
      gateway.handleConnection(client as any);
      const session = (gateway as any).sessions.get(client);
      session.clientId = 'bot-1';
      session.holdsSessionSlot = true;
      const provider = { close: jest.fn() };
      const mockSession = { close: jest.fn() };
      session.liveProvider = provider;
      session.mockSession = mockSession;
      const telemetry = (gateway as any).telemetryService;
      let finishFlush!: () => void;
      telemetry.flushAiBuffer.mockImplementation(() =>
        order === 'flush-failure'
          ? Promise.reject(new Error('persistence unavailable'))
          : new Promise<void>((resolve) => {
              finishFlush = resolve;
            }),
      );
      if (order === 'nest-first') void gateway.handleDisconnect(client as any);
      client.close(1000);
      const done = gateway.handleDisconnect(client as any);
      // Let teardown reach persistence while both disconnect paths are active.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      if (order !== 'flush-failure') {
        expect(factory.releaseSession).not.toHaveBeenCalled();
        finishFlush();
      }
      await done;
      await gateway.handleDisconnect(client as any);
      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(mockSession.close).toHaveBeenCalledTimes(1);
      expect(telemetry.flushAiBuffer).toHaveBeenCalledTimes(1);
      expect(factory.releaseSession).toHaveBeenCalledTimes(1);
      expect(factory.releaseSession).toHaveBeenCalledWith('bot-1');
      expect((gateway as any).sessions.has(client)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('rejects a start message without a session cookie', async () => {
    const client = new FakeClientSocket();
    const { gateway, voiceAuthService } = makeGateway();

    gateway.handleConnection(client as any);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'start' })));
    await new Promise((resolve) => setImmediate(resolve));

    expect(voiceAuthService.authenticateSession).toHaveBeenCalledWith('');
    expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'error',
      code: 'VOICE_AUTH_REQUIRED',
      message: 'Sessão de voz inválida.',
    });
    expect(client.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  it('recusa handshake sem Origin em production', () => {
    const { gateway } = makeGateway({ ENVIRONMENT: 'production' });
    const client = new FakeClientSocket();
    (client as any).handshakeRequest = { headers: {} };

    gateway.handleConnection(client as any);

    expect(client.close).toHaveBeenCalledWith(1008, 'Origin not allowed');
    expect(
      client.sent.some((payload) => payload.includes('VOICE_AUTH_REQUIRED')),
    ).toBe(false);
  });

  it('aceita handshake sem Origin fora de production', () => {
    const { gateway } = makeGateway({ ENVIRONMENT: 'development' });
    const client = new FakeClientSocket();
    expect(() => gateway.handleConnection(client as any)).not.toThrow();
    expect(client.close).not.toHaveBeenCalled();
    client.close(1000);
  });

  it('fecha conexões pre-auth acima do limite por IP (Redis INCR)', async () => {
    const { gateway } = makeGateway(
      { VOICE_MAX_PREAUTH_PER_IP: 10 },
      {
        getClient: () => ({
          incr: jest.fn().mockResolvedValue(11),
          expire: jest.fn().mockResolvedValue(1),
        }),
      },
    );
    const client = new FakeClientSocket();
    gateway.handleConnection(client as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.close).toHaveBeenCalledWith(1013, 'Too many connections');
  });

  it('identificação por IP usa a janela de 60s no Redis (key voice:preauth)', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const expire = jest.fn().mockResolvedValue(1);
    const { gateway } = makeGateway(
      {},
      { getClient: () => ({ incr, expire }) },
    );
    const client = new FakeClientSocket();
    (client as any).handshakeRequest = {
      headers: {},
      socket: { remoteAddress: '10.1.2.3' },
    };
    gateway.handleConnection(client as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(incr).toHaveBeenCalledWith('voice:preauth:10.1.2.3');
    expect(expire).toHaveBeenCalledWith('voice:preauth:10.1.2.3', 60);
    expect(client.close).not.toHaveBeenCalled();
    client.close(1000);
  });

  it('bloqueia a 11ª conexão WebSocket simultânea para um bot com limite 10 com BOT_CALL_LIMIT_EXCEEDED', async () => {
    const factory = new VoiceSessionFactory(
      {} as any,
      { get: jest.fn(() => 50) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const prisma = {
      painel_clients: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bot-10',
          max_concurrent_calls: 10,
          metadata: {},
        }),
      },
      painel_agents: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          client_id: 'bot-10',
          is_active: true,
          is_initial: true,
          interaction_mode: 'both',
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversations: {
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
    };

    const { gateway, voiceAuthService } = makeGateway(
      { GEMINI_API_KEY: 'mock-key', ENVIRONMENT: 'development' },
      undefined,
      factory,
      prisma,
    );

    voiceAuthService.authenticateSession = jest
      .fn()
      .mockResolvedValue({ company_id: 'comp-1' });
    voiceAuthService.resolveClientId = jest.fn().mockResolvedValue('bot-10');

    const clients: FakeClientSocket[] = [];

    // Conecta 10 clientes simultâneos
    for (let i = 0; i < 10; i++) {
      const client = new FakeClientSocket();
      clients.push(client);
      gateway.handleConnection(client as any);
      client.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'start', clientId: 'bot-10' })),
      );
    }
    await new Promise((resolve) => setImmediate(resolve));

    // Os 10 clientes devem ter sido aceitos (sem fechamento de socket)
    for (const c of clients) {
      expect(c.close).not.toHaveBeenCalled();
    }
    expect(factory.getActiveSessionsCount('bot-10')).toBe(10);

    // Conecta o 11º cliente
    const client11 = new FakeClientSocket();
    gateway.handleConnection(client11 as any);
    client11.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'start', clientId: 'bot-10' })),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // O 11º cliente deve ser BLOQUEADO com erro BOT_CALL_LIMIT_EXCEEDED e fechamento 1013
    expect(client11.sent.map((p) => JSON.parse(p))).toContainEqual({
      type: 'error',
      code: 'BOT_CALL_LIMIT_EXCEEDED',
      message:
        'Limite de chamadas ativas atingido para este bot (máximo: 10). Tente novamente em instantes.',
    });
    expect(client11.close).toHaveBeenCalledWith(
      1013,
      'Bot call limit exceeded',
    );

    // Desconecta um dos 10 clientes
    clients[0].emit('close', 1000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(factory.getActiveSessionsCount('bot-10')).toBe(9);

    // Conecta um 12º cliente agora que uma vaga foi liberada
    const client12 = new FakeClientSocket();
    gateway.handleConnection(client12 as any);
    client12.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'start', clientId: 'bot-10' })),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // O 12º cliente é aceito com sucesso
    expect(client12.close).not.toHaveBeenCalled();
    expect(factory.getActiveSessionsCount('bot-10')).toBe(10);

    // Teardown: fecha todas as conexões
    for (const c of clients) {
      c.close(1000);
    }
    client11.close(1000);
    client12.close(1000);
  });

  it.each([null, 0, 1200])(
    'aguarda a despedida e cancela timers se desconectar em %s ms',
    async (disconnectAt) => {
      const client = new FakeClientSocket();
      const factory = new VoiceSessionFactory(
        {} as any,
        { get: jest.fn(() => 50) } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const prisma = {
        painel_clients: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'bot-1',
            max_concurrent_calls: 10,
            metadata: {},
          }),
        },
        painel_agents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'agent-1',
            client_id: 'bot-1',
            is_active: true,
            is_initial: true,
            interaction_mode: 'both',
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        conversations: {
          create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
        },
      };

      const { gateway, voiceAuthService } = makeGateway(
        { GEMINI_API_KEY: 'mock-key', ENVIRONMENT: 'development' },
        undefined,
        factory,
        prisma,
      );

      voiceAuthService.authenticateSession = jest
        .fn()
        .mockResolvedValue({ company_id: 'comp-1' });
      voiceAuthService.resolveClientId = jest.fn().mockResolvedValue('bot-1');

      gateway.handleConnection(client as any);
      client.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'start', clientId: 'bot-1' })),
      );
      await new Promise((resolve) => setImmediate(resolve));

      const session = (gateway as any).sessions.get(client);
      expect(session).toBeDefined();

      const provider = session.liveProvider;
      expect(provider).toBeDefined();

      const sendToolResponseSpy = jest.spyOn(provider, 'sendToolResponse');
      jest.useFakeTimers();

      // Simula a IA solicitando a tool finalizar_chamada com mensagem_despedida
      await (provider.options as any).onToolCall([
        {
          id: 'call-hangup-1',
          name: 'finalizar_chamada',
          args: { mensagem_despedida: 'Muito obrigado, tenha um ótimo dia!' },
        },
      ]);

      // Valida que a toolResponse confirmou o encerramento sem forçar repetição de fala
      expect(sendToolResponseSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'call-hangup-1',
            name: 'finalizar_chamada',
            response: {
              ok: true,
              message: buildVoiceFarewellToolResponse(),
            },
          }),
        ]),
      );

      // O socket NÃO deve ter sido fechado imediatamente e call_ended NÃO deve ter sido emitido ainda
      expect(client.close).not.toHaveBeenCalled();
      const sentMessages = client.sent.map((p: string) => JSON.parse(p));
      expect(
        sentMessages.find((m: any) => m.type === 'call_ended'),
      ).toBeUndefined();
      expect(session.pendingAiHangup).toBe(true);

      // Agora simula o término da fala da IA (onTurnComplete)
      await (provider.options as any).onTurnComplete();
      await (provider.options as any).onTurnComplete();

      if (disconnectAt !== null) {
        await jest.advanceTimersByTimeAsync(disconnectAt);
        client.close(1000);
        await gateway.handleDisconnect(client as any);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(2000);
        expect(client.close).toHaveBeenCalledTimes(1);
        expect((gateway as any).sessions.has(client)).toBe(false);
        return;
      }

      // Aguarda a margem de segurança acústica (1200ms + 400ms)
      await jest.advanceTimersByTimeAsync(1700);

      // Agora sim a chamada foi encerrada graciosamente após a despedida
      const updatedMessages = client.sent.map((p: string) => JSON.parse(p));
      expect(updatedMessages.find((m: any) => m.type === 'call_ended')).toEqual(
        {
          type: 'call_ended',
          reason: 'ai_requested',
        },
      );
      expect(client.close).toHaveBeenCalledWith(
        1000,
        'AI requested hangup completed',
      );
    },
  );

  it('reproduz saudacao acelerada via VoiceGreetingCacheService quando voice_greeting_cache_enabled está ativo no agente', async () => {
    const client = new FakeClientSocket();
    const factory = new VoiceSessionFactory(
      {} as any,
      { get: jest.fn(() => 50) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const greetingCacheService = {
      resolveOrSynthesizeGreeting: jest.fn().mockResolvedValue({
        audioBuffer: Buffer.alloc(9600, 1),
        text: 'Olá Edinaldo, tudo bem?',
        fromCache: true,
        hash: 'hash-mock',
      }),
    };

    const prisma = {
      painel_clients: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bot-1',
          max_concurrent_calls: 10,
          metadata: { voice_engine: 'hybrid' },
        }),
      },
      painel_agents: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          client_id: 'bot-1',
          is_active: true,
          is_initial: true,
          interaction_mode: 'both',
          transitions: {
            capabilities: {
              ai_speaks_first: true,
              voice_greeting_cache_enabled: true,
              greeting_message: 'Olá Edinaldo, tudo bem?',
            },
          },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversations: {
        create: jest.fn().mockResolvedValue({ id: 'conv-cache-1' }),
      },
      messages: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      },
    };

    const { gateway, voiceAuthService } = makeGateway(
      {
        CARTESIA_API_KEY: 'mock-cartesia',
        GEMINI_API_KEY: 'mock-gemini',
        ENVIRONMENT: 'development',
      },
      undefined,
      factory,
      prisma,
      greetingCacheService,
    );

    voiceAuthService.authenticateSession = jest
      .fn()
      .mockResolvedValue({ company_id: 'comp-1' });
    voiceAuthService.resolveClientId = jest.fn().mockResolvedValue('bot-1');

    gateway.handleConnection(client as any);
    client.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'start', clientId: 'bot-1' })),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      greetingCacheService.resolveOrSynthesizeGreeting,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'comp-1',
        agentId: 'agent-1',
        provider: 'cartesia',
        template: 'Olá Edinaldo, tudo bem?',
      }),
    );

    const sentMessages = client.sent.map((p: string) => JSON.parse(p));
    // Verifica que o frame de audio e a transcricao foram enviados ao cliente web
    const audioMsg = sentMessages.find((m: any) => m.type === 'audio');
    const transcriptMsg = sentMessages.find(
      (m: any) => m.type === 'ai_transcript',
    );
    expect(audioMsg).toBeDefined();
    expect(transcriptMsg).toBeDefined();
    expect(transcriptMsg.text).toBe('Olá Edinaldo, tudo bem?');
  });
});

describe('VoiceGateway subscription authorization', () => {
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  function setup(authenticated = true) {
    const { gateway, voiceAuthService } = makeGateway();
    if (authenticated)
      voiceAuthService.authenticateSession.mockResolvedValue({
        id: 'user',
        company_id: 'tenant-a',
        role: 'member',
      });
    voiceAuthService.resolveClientId.mockImplementation(
      async (_company, client) => {
        if (client !== 'own-client') throw new Error('denied');
        return client;
      },
    );
    const registry = {
      getActiveCalls: jest.fn().mockResolvedValue([]),
      getCall: jest.fn(),
      getCallFromRedis: jest.fn().mockResolvedValue(null),
      subscribeAudio: jest.fn().mockReturnValue(jest.fn()),
    };
    const hangup = jest.fn();
    (gateway as any).activeCallsRegistry = registry;
    (gateway as any).audioSocketServerService = { hangupTestCall: hangup };
    const socket = new FakeClientSocket();
    gateway.handleConnection(socket as any);
    return { gateway, voiceAuthService, registry, hangup, socket };
  }
  it.each([
    'monitoring_subscribe',
    'subscribe_live_audio',
    'flow_listener_subscribe',
    'flow_telephony_hangup',
  ])('rejects unauthenticated %s', async (type) => {
    const { socket, registry, hangup, voiceAuthService } = setup(false);
    socket.emit(
      'message',
      JSON.stringify({ type, clientId: 'own-client', callId: 'call' }),
    );
    await turn();
    expect(voiceAuthService.authenticateSession).toHaveBeenCalled();
    expect(registry.getActiveCalls).not.toHaveBeenCalled();
    expect(registry.subscribeAudio).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });
  it('derives monitoring tenant from session and blocks a foreign scope', async () => {
    const { socket, registry } = setup();
    socket.emit('message', JSON.stringify({ type: 'monitoring_subscribe' }));
    await turn();
    expect(registry.getActiveCalls).toHaveBeenCalledWith('tenant-a');
    socket.emit(
      'message',
      JSON.stringify({ type: 'monitoring_subscribe', companyId: 'tenant-b' }),
    );
    await turn();
    expect(registry.getActiveCalls).toHaveBeenCalledTimes(1);
  });
  it('blocks foreign calls and cancels a duplicate audio subscription', async () => {
    const { socket, registry } = setup();
    registry.getCall.mockReturnValue({ companyId: 'tenant-b' });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe_live_audio', callId: 'call' }),
    );
    await turn();
    expect(registry.subscribeAudio).not.toHaveBeenCalled();
    registry.getCall.mockReturnValue({ companyId: 'tenant-a' });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe_live_audio', callId: 'call' }),
    );
    await turn();
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe_live_audio', callId: 'call' }),
    );
    await turn();
    expect(registry.subscribeAudio.mock.results[0].value).toHaveBeenCalledTimes(
      1,
    );
  });
  it('never hangs up without an owned client identifier', async () => {
    const { socket, hangup } = setup();
    for (const clientId of [undefined, 'foreign']) {
      socket.emit(
        'message',
        JSON.stringify({ type: 'flow_telephony_hangup', clientId }),
      );
      await turn();
    }
    expect(hangup).not.toHaveBeenCalled();
    socket.emit(
      'message',
      JSON.stringify({ type: 'flow_telephony_hangup', clientId: 'own-client' }),
    );
    await turn();
    expect(hangup).toHaveBeenCalledWith('own-client');
  });
  it('broadcasts only subscribed tenant events and stops after revocation', async () => {
    const { socket, gateway, voiceAuthService } = setup();
    gateway.broadcast({ type: 'call_started', companyId: 'tenant-a' });
    await turn();
    expect(socket.sent).toHaveLength(0);
    socket.emit('message', JSON.stringify({ type: 'monitoring_subscribe' }));
    await turn();
    socket.sent = [];
    gateway.broadcast({ type: 'call_started', companyId: 'tenant-b' });
    await turn();
    expect(socket.sent).toHaveLength(0);
    gateway.broadcast({ type: 'call_started', companyId: 'tenant-a' });
    await turn();
    expect(socket.sent).toHaveLength(1);
    voiceAuthService.authenticateSession.mockRejectedValue(
      new Error('revoked'),
    );
    gateway.broadcast({ type: 'call_updated', companyId: 'tenant-a' });
    await turn();
    expect(
      socket.sent.some((raw) => JSON.parse(raw).type === 'call_updated'),
    ).toBe(false);
    expect(socket.close).toHaveBeenCalled();
  });

  it('bounds audio authorization caching and blocks frames after revocation', async () => {
    const { socket, gateway, voiceAuthService } = setup();
    const handleClientAudio = jest.fn();
    (gateway as any).sessions.get(socket).callAdapter = {
      handleClientAudio,
      close: jest.fn(),
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
    try {
      for (let i = 0; i < 50; i++) {
        socket.emit('message', JSON.stringify({ type: 'audio', data: 'AAA=' }));
        await turn();
      }
      expect(voiceAuthService.authenticateSession).toHaveBeenCalledTimes(1);
      expect(handleClientAudio).toHaveBeenCalledTimes(50);
      voiceAuthService.authenticateSession.mockRejectedValue(
        new Error('revoked'),
      );
      now.mockReturnValue(11000);
      socket.emit('message', JSON.stringify({ type: 'audio', data: 'AAA=' }));
      await turn();
      expect(handleClientAudio).toHaveBeenCalledTimes(50);
      expect(socket.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    } finally {
      now.mockRestore();
    }
  });
});
