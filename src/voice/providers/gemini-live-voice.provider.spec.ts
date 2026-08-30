import { GeminiLiveVoiceProvider } from './gemini-live-voice.provider';
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
