import { VoiceCallSession } from './voice-call-session';
import { buildVoiceFarewellToolResponse } from '../services/voice-runtime.util';

it.each([
  [true, false, 3000, 'Pode parar', true, false],
  [false, false, 3000, 'Pode parar', false, false],
  [true, true, 3000, 'Pode parar', false, false],
  [true, false, 0, 'Pode parar', false, false],
  [true, false, 3000, '  ', false, false],
  [true, true, 3000, 'Pode parar', false, true],
  [false, true, 3000, 'Pode parar', false, true],
] as const)(
  'interrompe a cauda telefônica após turnComplete: permitido=%s saudação=%s fila=%s texto=%s',
  async (allowed, greeting, queuedMs, text, expected, initial) => {
    jest.useFakeTimers();
    let queue = queuedMs as number;
    const clearQueuedAudio = jest.fn(() => {
      queue = 0;
    });
    const adapter = {
      id: 'call',
      metadata: { customVariables: {} },
      onAudio: jest.fn(),
      onCallEnd: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      sendAudio: jest.fn(),
      finishAudio: jest.fn(),
      clearQueuedAudio,
      getQueuedAudioMs: () => queue,
    };
    const provider = {
      connect: jest.fn(),
      close: jest.fn(),
      setInterruptionBlocked: jest.fn(),
    };
    const processChunk = jest.fn().mockReturnValue({ forwardChunks: [] });
    const session = new VoiceCallSession({
      telephonyAdapter: adapter as any,
      liveProvider: provider as any,
      audioGateService: {
        createSession: () => ({
          notifyAiSpeakingChanged: jest.fn(),
          getStats: jest.fn(),
          processChunk,
        }),
      } as any,
      pricingService: { calculateVoiceLiveCost: () => 0 } as any,
      prisma: {
        painel_clients: {
          findUnique: jest.fn().mockResolvedValue({
            agent_name: 'Ana',
            company_name: 'Empresa',
          }),
        },
      } as any,
      config: {
        clientId: 'client',
        voiceEngine: 'live_api',
        selectedAgent: {
          id: 'agent',
          allow_interrupted: allowed,
          is_initial: initial,
        },
      },
    });
    try {
      await session.start();
      const callbacks = provider.connect.mock.calls[0][0];
      callbacks.onAudio(Buffer.alloc(960).toString('base64'));
      callbacks.onTurnComplete();
      if (!initial) session.isGreetingPlaying = greeting;
      else expect(session.isGreetingPlaying).toBe(true);
      adapter.onAudio.mock.calls[0][0](Buffer.alloc(640));
      expect(processChunk).toHaveBeenLastCalledWith(
        expect.any(String),
        queuedMs > 0,
      );
      await callbacks.onUserTranscript(text);
      expect(clearQueuedAudio).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(session.interruptedCount).toBe(expected ? 1 : 0);
      // Fragmentos posteriores não contam outra interrupção da mesma fila.
      await callbacks.onUserTranscript(text);
      expect(clearQueuedAudio).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (initial) {
        callbacks.onInterrupted();
        expect(clearQueuedAudio).not.toHaveBeenCalled();
        expect(provider.setInterruptionBlocked).toHaveBeenLastCalledWith(true);
        await jest.advanceTimersByTimeAsync(queuedMs + 200);
        expect(session.isGreetingPlaying).toBe(false);
        expect(provider.setInterruptionBlocked).toHaveBeenLastCalledWith(false);
        callbacks.onAudio(Buffer.alloc(960).toString('base64'));
        callbacks.onTurnComplete();
        await callbacks.onUserTranscript(text);
        expect(clearQueuedAudio).toHaveBeenCalledTimes(allowed ? 1 : 0);
      }
    } finally {
      await session.end('test-completed');
      jest.useRealTimers();
    }
  },
);

it.each([
  ['live_api', true],
  ['hybrid', true],
  ['live_api', false],
  ['hybrid', false],
] as const)(
  'keeps late API and chain results on their original transcript turn in %s (success: %s)',
  async (engine, success) => {
    const events: any[] = [];
    const waiting = jest.fn();
    let resolveFirst!: (value: unknown) => void;
    const firstResult = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const provider = {
      connect: jest.fn(),
      close: jest.fn(),
      sendText: jest.fn(),
      sendToolResponse: jest.fn(),
    };
    const tools = {
      getAgentTools: jest.fn().mockResolvedValue([
        {
          id: 'api',
          name: 'debts',
          parameters: { type: 'OBJECT', properties: {} },
        },
      ]),
      getAgentSubagents: jest.fn().mockResolvedValue([]),
      execute: jest
        .fn()
        .mockReturnValueOnce(firstResult)
        .mockResolvedValueOnce({ ok: false, error: 'timeout' }),
    };
    const session = new VoiceCallSession({
      telephonyAdapter: {
        id: 'call',
        providerName: 'test',
        setWaiting: waiting,
        metadata: { customVariables: {} },
        onAudio: jest.fn(),
        onCallEnd: jest.fn(),
        start: jest.fn(),
        close: jest.fn(),
      } as any,
      liveProvider: provider as any,
      audioGateService: {
        createSession: () => ({
          notifyAiSpeakingChanged: jest.fn(),
          getStats: () => undefined,
        }),
      } as any,
      pricingService: {
        calculateVoiceLiveCost: () => 0,
        calculateHybridVoiceCost: () => 0,
      } as any,
      prisma: {
        painel_clients: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ agent_name: 'Ana', company_name: 'Empresa' }),
        },
        painel_agents: { findMany: jest.fn().mockResolvedValue([]) },
      } as any,
      voiceToolsService: tools as any,
      config: {
        clientId: 'client',
        agentId: 'agent',
        selectedAgent: { id: 'agent' },
        voiceEngine: engine as 'live_api' | 'hybrid',
        onEvent: (event) => events.push(event),
      },
    });
    try {
      await session.start();
      const callbacks = provider.connect.mock.calls[0][0];
      await callbacks.onUserTranscript('Consulta inicial');
      const pending = callbacks.onToolCall([
        { id: 'call-1', name: 'debts', args: { customer: 1 } },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(waiting).toHaveBeenLastCalledWith(true);
      await callbacks.onAiTranscript('Consultando');
      await callbacks.onUserTranscript('Consultar outro cliente');
      await callbacks.onToolCall([
        { id: 'call-2', name: 'debts', args: { customer: 2 } },
      ]);
      const childResponse = success
        ? { ok: true, plans: [1] }
        : { ok: false, error: 'extraction_empty', message: 'Sem ofertas' };
      const response = {
        balance: 10,
        ...childResponse,
        _chainTrail: [{ from: 'debts', to: 'offers', response: childResponse }],
      };
      resolveFirst(response);
      await pending;
      expect(waiting).toHaveBeenLastCalledWith(false);
      const transcripts = events.filter(
        (event) => event.type === 'flow_telephony_transcript',
      );
      const starts = events.filter(
        (event) => event.type === 'flow_telephony_tool_call',
      );
      const completions = events.filter(
        (event) => event.type === 'flow_telephony_tool_response',
      );
      const chain = events.find(
        (event) => event.type === 'flow_telephony_chaining',
      );
      expect(transcripts[0].turn_id).toBe(transcripts[1].turn_id);
      expect(transcripts[2].turn_id).not.toBe(transcripts[0].turn_id);
      expect(starts[0].turn_id).toBe(transcripts[0].turn_id);
      expect(starts[1].turn_id).toBe(transcripts[2].turn_id);
      expect(
        completions.find(
          (event) => event.execution_id === starts[0].execution_id,
        ),
      ).toMatchObject({ turn_id: transcripts[0].turn_id, response });
      expect(
        completions.find(
          (event) => event.execution_id === starts[1].execution_id,
        ),
      ).toMatchObject({
        turn_id: transcripts[2].turn_id,
        response: { ok: false, error: 'timeout' },
      });
      expect(chain.turn_id).toBe(transcripts[0].turn_id);
      expect(chain.response).toEqual(childResponse);
      if (!success) {
        expect(
          events.some((event) => event.type === 'flow_telephony_variables'),
        ).toBe(false);
      }
      expect(chain.execution_id).not.toBe(starts[0].execution_id);
      expect(provider.sendToolResponse).toHaveBeenCalledWith([
        { id: 'call-1', name: 'debts', response },
      ]);
    } finally {
      await session.end('test-completed');
    }
  },
);

describe('Telephony farewell tool', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([
    'pending-farewell',
    'grace-period',
    'pending-request',
    'pending-adapter',
  ])('cancela o encerramento tardio após remote_hangup: %s', async (phase) => {
    const adapter = {
      id: 'call',
      providerName: 'test',
      metadata: { customVariables: {} },
      onAudio: jest.fn(),
      onCallEnd: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      hangup: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      finishAudio: jest.fn(),
    };
    const provider = {
      connect: jest.fn(),
      sendToolResponse: jest.fn(),
      sendText: jest.fn(),
      close: jest.fn(),
    };
    const onAiHangupRequest = jest.fn().mockResolvedValue(undefined);
    const session = new VoiceCallSession({
      telephonyAdapter: adapter as any,
      liveProvider: provider as any,
      audioGateService: {
        createSession: (config: { enabled: boolean }) => {
          expect(config.enabled).toBe(false);
          return {
            notifyAiSpeakingChanged: jest.fn(),
            getStats: jest.fn(),
          };
        },
      } as any,
      pricingService: {
        calculateVoiceLiveCost: jest.fn().mockReturnValue(0),
      } as any,
      prisma: {
        painel_clients: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ agent_name: 'Ana', company_name: 'Empresa' }),
        },
      } as any,
      config: {
        clientId: 'client',
        selectedAgent: { id: 'agent' },
        voiceEngine: 'live_api',
        onAiHangupRequest,
      },
    });
    await session.start();
    const options = provider.connect.mock.calls[0][0];
    await options.onToolCall([
      { id: 'hangup', name: 'finalizar_chamada', args: {} },
    ]);
    options.onTurnComplete();
    options.onTurnComplete();
    expect(adapter.finishAudio).toHaveBeenCalledTimes(2);
    let resolveHangup: (() => void) | undefined;
    if (phase === 'pending-request' || phase === 'pending-adapter') {
      const pending = new Promise<void>((resolve) => {
        resolveHangup = resolve;
      });
      (phase === 'pending-request'
        ? onAiHangupRequest
        : adapter.hangup
      ).mockReturnValue(pending);
    }
    if (phase !== 'pending-farewell') await jest.advanceTimersByTimeAsync(1500);
    const endSpy = jest.spyOn(session, 'end');
    await session.end('remote_hangup');
    resolveHangup?.();
    await jest.advanceTimersByTimeAsync(0);
    options.onTurnComplete();
    expect(adapter.finishAudio).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10000);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(adapter.hangup).toHaveBeenCalledTimes(
      phase === 'pending-farewell' || phase === 'pending-request' ? 0 : 1,
    );
    expect(provider.close).toHaveBeenCalledTimes(1);
  });

  it.each(['live_api', 'hybrid'])(
    'mantém a orientação de idioma no retorno e aguarda a despedida em %s',
    async (engine) => {
      const adapter = {
        id: 'call',
        providerName: 'test',
        metadata: { customVariables: {}, callerNumber: '', didNumber: '' },
        onAudio: jest.fn(),
        onCallEnd: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        hangup: jest.fn().mockResolvedValue(undefined),
      };
      const provider = {
        connect: jest.fn(),
        sendToolResponse: jest.fn(),
        sendText: jest.fn(),
      };
      const onAiHangupRequest = jest.fn().mockResolvedValue(undefined);
      const session = new VoiceCallSession({
        telephonyAdapter: adapter as any,
        liveProvider: provider as any,
        audioGateService: {
          createSession: () => ({ notifyAiSpeakingChanged: jest.fn() }),
        } as any,
        pricingService: {} as any,
        prisma: {
          painel_clients: {
            findUnique: jest.fn().mockResolvedValue({
              agent_name: 'Ana',
              company_name: 'Empresa',
            }),
          },
        } as any,
        config: {
          clientId: 'client',
          selectedAgent: { id: 'agent', service_step: 'Atendimento' },
          voiceEngine: engine as 'live_api' | 'hybrid',
          onAiHangupRequest,
        },
      });
      await session.start();
      const options = provider.connect.mock.calls[0][0];
      expect(options.systemPrompt).toContain('mesmo idioma do atendimento');
      await options.onToolCall([
        {
          id: 'hangup-1',
          name: 'finalizar_chamada',
          args: { mensagem_despedida: 'Obrigada pelo contato, até logo!' },
        },
      ]);
      expect(provider.sendToolResponse).toHaveBeenCalledWith([
        {
          id: 'hangup-1',
          name: 'finalizar_chamada',
          response: { ok: true, message: buildVoiceFarewellToolResponse() },
        },
      ]);
      expect(adapter.hangup).not.toHaveBeenCalled();
      options.onTurnComplete();
      await jest.advanceTimersByTimeAsync(1600);
      expect(onAiHangupRequest).toHaveBeenCalledTimes(1);
      expect(adapter.hangup).toHaveBeenCalledWith('ai_requested');
    },
  );
});

describe('Inactivity telephony hangup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it.each(['live_api', 'hybrid'])(
    'requests physical hangup for %s after the final utterance',
    async (engine) => {
      const adapter = {
        id: 'call',
        hangup: jest.fn().mockResolvedValue(undefined),
      };
      const provider = { sendText: jest.fn() };
      const onAiHangupRequest = jest.fn().mockResolvedValue(undefined);
      const session = new VoiceCallSession({
        telephonyAdapter: adapter as any,
        liveProvider: provider as any,
        audioGateService: {} as any,
        pricingService: {} as any,
        prisma: {} as any,
        config: {
          voiceEngine: engine as 'live_api' | 'hybrid',
          onAiHangupRequest,
          voiceBehavior: {
            idleEnabled: true,
            turns: [{ text: 'Tchau', waitSeconds: 5, endCall: true }],
          },
        },
      });
      const inactivity = (session as any).inactivity;
      inactivity.start();
      jest.advanceTimersByTime(5000);
      expect(provider.sendText).toHaveBeenCalledWith(
        expect.stringContaining('Tchau'),
      );
      expect(adapter.hangup).not.toHaveBeenCalled();
      inactivity.outputComplete();
      await jest.advanceTimersByTimeAsync(300);
      expect(onAiHangupRequest).toHaveBeenCalledTimes(1);
      expect(adapter.hangup).toHaveBeenCalledWith('inactivity');
    },
  );
});

describe('Telephony agent transition', () => {
  it('preserva o áudio anterior e reconecta com prompt, voz e ferramentas do novo agente', async () => {
    const adapter = {
      id: 'call',
      providerName: 'test',
      metadata: { customVariables: {}, callerNumber: '', didNumber: '' },
      clearQueuedAudio: jest.fn(),
      onAudio: jest.fn(),
      onCallEnd: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
    };
    const provider = {
      connect: jest.fn(),
      close: jest.fn(),
      waitForOutput: jest.fn().mockResolvedValue(undefined),
      sendToolResponse: jest.fn(),
      sendText: jest.fn(),
    };
    const nextAgent = {
      id: 'agent-b',
      service_step: 'Suporte',
      system_prompt: 'Você é o agente de suporte.',
      model: 'gemini-3.8-live',
      voice_name: 'Kore',
      activation_conditions: {
        logic: 'AND',
        conditions: [{ variable: 'phase', operator: 'equals', value: 'next' }],
      },
    };
    const tools = {
      getAgentTools: jest.fn(async (_clientId: string, agentId: string) => [
        {
          id: 'tool',
          name: agentId === 'agent-b' ? 'new_tool' : 'lookup',
          description: 'Consulta',
          parameters: { type: 'OBJECT', properties: {} },
        },
      ]),
      getAgentSubagents: jest.fn().mockResolvedValue([]),
      execute: jest
        .fn()
        .mockResolvedValue({ ok: true, data: { phase: 'next' } }),
    };
    const session = new VoiceCallSession({
      telephonyAdapter: adapter as any,
      liveProvider: provider as any,
      audioGateService: {
        createSession: () => ({ notifyAiSpeakingChanged: jest.fn() }),
      } as any,
      pricingService: {} as any,
      prisma: {
        painel_clients: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ agent_name: 'Ana', company_name: 'Empresa' }),
        },
        painel_agents: { findMany: jest.fn().mockResolvedValue([nextAgent]) },
      } as any,
      voiceToolsService: tools as any,
      config: {
        clientId: 'client',
        selectedAgent: { id: 'agent-a', service_step: 'Triagem' },
        agentId: 'agent-a',
        model: 'gemini-3.8-live',
        voiceName: 'Aoede',
        voiceEngine: 'live_api',
        geminiLive: { model: 'gemini-3.8-live', voiceName: 'Aoede' },
      },
    });

    await session.start();
    const initialOptions = provider.connect.mock.calls[0][0];
    await initialOptions.onToolCall([
      { id: 'call-1', name: 'lookup', args: {} },
    ]);

    expect(adapter.clearQueuedAudio).not.toHaveBeenCalled();
    expect(provider.sendToolResponse).not.toHaveBeenCalled();
    expect(provider.waitForOutput).toHaveBeenCalledTimes(1);
    expect(provider.waitForOutput.mock.invocationCallOrder[0]).toBeLessThan(
      provider.close.mock.invocationCallOrder[0],
    );
    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(provider.connect).toHaveBeenCalledTimes(2);
    const nextOptions = provider.connect.mock.calls[1][0];
    expect(nextOptions.voiceName).toBe('Kore');
    expect(nextOptions.geminiLive).toMatchObject({ voiceName: 'Kore' });
    expect(
      nextOptions.tools[0].functionDeclarations.map((tool: any) => tool.name),
    ).toEqual(expect.arrayContaining(['new_tool', 'set_call_variable']));
    expect(
      nextOptions.tools[0].functionDeclarations.map((tool: any) => tool.name),
    ).not.toContain('lookup');
    expect(nextOptions.systemPrompt).toContain('Você é o agente de suporte.');
    nextOptions.onSetupComplete();
    expect(provider.sendText).toHaveBeenCalledWith(
      expect.stringContaining('TRANSFERÊNCIA DE ATENDIMENTO'),
    );
  });
});

it('stops media and releases capacity before waiting for pending persistence', async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const provider = { close: jest.fn() };
  const adapter = { id: 'quota-call', metadata: {}, close: jest.fn() };
  const release = jest.fn();
  const session = new VoiceCallSession({
    telephonyAdapter: adapter as any,
    liveProvider: provider as any,
    audioGateService: {} as any,
    pricingService: { calculateVoiceLiveCost: () => 0 } as any,
    prisma: {} as any,
    config: { onSessionEnd: release },
  });
  (session as any).pendingWork = { drain: () => pending };
  const ending = session.end('capacity_lease_lost');
  expect(provider.close).toHaveBeenCalledTimes(1);
  expect(adapter.close).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  await session.end('remote_hangup');
  complete();
  await ending;
  expect(release).toHaveBeenCalledTimes(1);
});
