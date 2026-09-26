import { VoiceCallSession } from './voice-call-session';
import { buildVoiceFarewellToolResponse } from '../services/voice-runtime.util';

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
        createSession: () => ({
          notifyAiSpeakingChanged: jest.fn(),
          getStats: jest.fn(),
        }),
      } as any,
      pricingService: {
        calculateVoiceLiveCost: jest.fn().mockReturnValue(0),
      } as any,
      prisma: {
        painel_clients: { findUnique: jest.fn().mockResolvedValue(null) },
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
          painel_clients: { findUnique: jest.fn().mockResolvedValue(null) },
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
        painel_clients: { findUnique: jest.fn().mockResolvedValue(null) },
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
