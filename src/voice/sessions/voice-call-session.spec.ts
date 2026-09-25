import { VoiceCallSession } from './voice-call-session';
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
  it('descarta o áudio anterior e reconecta com prompt, voz e ferramentas do novo agente', async () => {
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

    expect(adapter.clearQueuedAudio).toHaveBeenCalledTimes(1);
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
