import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { VoiceGateway } from './voice.gateway';

class FakeClientSocket extends EventEmitter {
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

  const gateway = new VoiceGateway(
    voiceService as any,
    voiceAuthService as any,
    {} as any,
    audioGateService as any,
    voiceSessionFactory ?? ({} as any),
    configService as any,
    prismaService ?? ({} as any),
    voiceToolsService as any,
    {} as any,
    nativeToolsService as any,
    {
      flushAiBuffer: jest.fn(),
      persistSessionTelemetry: jest.fn(),
      persistConversationState: jest.fn(),
      buildTelemetryPayload: jest.fn().mockReturnValue(null),
    } as any,
    redisService as any,
    cartesiaTtsService as any,
    groqWhisperSttService as any,
    sileroVadService as any,
    keyResolver as any,
    greetingCacheService,
  );
  return {
    gateway,
    voiceAuthService,
    configService,
  };
}

describe('VoiceGateway security', () => {
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
      message: 'Autenticação necessária para iniciar a sessão de voz.',
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

  it('não encerra imediatamente quando a IA solicita finalizar_chamada, aguardando a conclusão da fala da despedida', async () => {
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
            message: 'Encerramento confirmado.',
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
    (provider.options as any).onTurnComplete();

    // Aguarda a margem de segurança acústica (1200ms + 400ms)
    await new Promise((resolve) => setTimeout(resolve, 1700));

    // Agora sim a chamada foi encerrada graciosamente após a despedida
    const updatedMessages = client.sent.map((p: string) => JSON.parse(p));
    expect(updatedMessages.find((m: any) => m.type === 'call_ended')).toEqual({
      type: 'call_ended',
      reason: 'ai_requested',
    });
    expect(client.close).toHaveBeenCalledWith(
      1000,
      'AI requested hangup completed',
    );
  });

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
