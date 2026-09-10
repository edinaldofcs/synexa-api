import {
  DEFAULT_LIVE_MODEL,
  GeminiLiveVoiceProvider,
  resolveLiveModel,
  resolveLiveVoice,
} from './gemini-live-voice.provider';
import WebSocketMock from 'ws';

jest.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static instances: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    on = jest.fn();
    send = jest.fn();
    close = jest.fn();
    constructor() {
      MockWebSocket.instances.push(this);
    }
  }
  return { __esModule: true, default: MockWebSocket };
});

interface MockWsInstance {
  readyState: number;
  bufferedAmount: number;
  send: jest.Mock;
}

const buildConnectedProvider = () => {
  const provider = new GeminiLiveVoiceProvider();
  provider.connect({
    apiKey: 'test-key',
    systemPrompt: 'prompt',
  });
  const ws = (WebSocketMock as any).instances.slice(-1)[0] as MockWsInstance;
  return { provider, ws };
};

describe('resolveLiveModel', () => {
  it('mantém o modelo configurado quando ele suporta Live (bidiGenerateContent)', () => {
    expect(resolveLiveModel('gemini-2.0-flash-live-001')).toBe(
      'gemini-2.0-flash-live-001',
    );
    expect(
      resolveLiveModel('gemini-2.5-flash-preview-native-audio-dialog'),
    ).toBe('gemini-2.5-flash-preview-native-audio-dialog');
    expect(resolveLiveModel(DEFAULT_LIVE_MODEL)).toBe(DEFAULT_LIVE_MODEL);
  });

  it('cai para o modelo default quando o configurado é de texto/chat', () => {
    expect(resolveLiveModel('openai/gpt-oss-120b')).toBe(DEFAULT_LIVE_MODEL);
    expect(resolveLiveModel('gemini-2.5-flash')).toBe(DEFAULT_LIVE_MODEL);
    expect(resolveLiveModel('gemini-2.0-flash-exp')).toBe(DEFAULT_LIVE_MODEL);
    expect(resolveLiveModel(undefined)).toBe(DEFAULT_LIVE_MODEL);
    expect(resolveLiveModel(null)).toBe(DEFAULT_LIVE_MODEL);
  });
});

describe('resolveLiveVoice', () => {
  it('mantém vozes válidas do Google Gemini Live', () => {
    expect(resolveLiveVoice('Aoede')).toBe('Aoede');
    expect(resolveLiveVoice('Kore')).toBe('Kore');
    expect(resolveLiveVoice('Puck')).toBe('Puck');
    expect(resolveLiveVoice('Charon')).toBe('Charon');
    expect(resolveLiveVoice('Fenrir')).toBe('Fenrir');
  });

  it('normaliza vozes em lowercase para a forma correta', () => {
    expect(resolveLiveVoice('kore')).toBe('Kore');
    expect(resolveLiveVoice('aoede')).toBe('Aoede');
  });

  it('cai para Aoede quando receber UUID da Cartesia, formato Wavenet ou valor nulo', () => {
    expect(resolveLiveVoice('cb2694c3-715f-4da9-99f3-1c974fff2928')).toBe('Aoede');
    expect(resolveLiveVoice('pt-BR-Wavenet-A')).toBe('Aoede');
    expect(resolveLiveVoice('')).toBe('Aoede');
    expect(resolveLiveVoice(undefined)).toBe('Aoede');
    expect(resolveLiveVoice(null)).toBe('Aoede');
  });
});

describe('GeminiLiveVoiceProvider - backpressure (ws.bufferedAmount)', () => {
  afterEach(() => {
    (WebSocketMock as any).instances.length = 0;
    delete process.env.VOICE_WS_BACKPRESSURE_BYTES;
  });

  it('envia o frame quando o buffer esta abaixo do teto (1MB default)', () => {
    const { provider, ws } = buildConnectedProvider();
    ws.bufferedAmount = 1024;

    provider.sendAudio('aGVsbG8=');

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(provider.droppedAudioFrames).toBe(0);
  });

  it('descarta o frame e conta quando o buffer excede o teto (env VOICE_WS_BACKPRESSURE_BYTES)', () => {
    process.env.VOICE_WS_BACKPRESSURE_BYTES = '100';
    const { provider, ws } = buildConnectedProvider();
    ws.bufferedAmount = 4096;

    provider.sendAudio('aGVsbG8=');
    provider.sendAudio('aGVsbG8=');
    provider.sendAudio('aGVsbG8=');

    expect(ws.send).not.toHaveBeenCalled();
    expect(provider.droppedAudioFrames).toBe(3);
  });
});
