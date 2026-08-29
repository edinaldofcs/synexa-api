import {
  VonageVoiceAdapter,
  VonageVoiceAdapterConfig,
} from './vonage-voice.adapter';

class FakeWebSocket {
  public readyState = 1; // OPEN
  public closed = false;
  public sent: Array<Buffer | string> = [];
  private handlers: Record<string, Array<(...args: any[]) => void>> = {};

  public on(event: string, cb: (...args: any[]) => void): void {
    (this.handlers[event] ||= []).push(cb);
  }

  public emit(event: string, ...args: any[]): void {
    for (const cb of this.handlers[event] || []) cb(...args);
  }

  public send(data: Buffer | string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
  }

  public sentJson(): any[] {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s));
  }

  public sentBinary(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}

function makeAdapter(overrides?: Partial<VonageVoiceAdapterConfig>) {
  const ws = new FakeWebSocket();
  const adapter = new VonageVoiceAdapter({
    wsSocket: ws as any,
    metadata: { didNumber: '+5511999990000' },
    ...overrides,
  });
  return { ws, adapter };
}

function connectEvent(headers: Record<string, string> = {}) {
  return Buffer.from(
    JSON.stringify({
      event: 'websocket:connected',
      'content-type': 'audio/l16;rate=16000',
      ...headers,
    }),
  );
}

describe('VonageVoiceAdapter', () => {
  it('identifica a stream no websocket:connected e extrai headers do NCCO', async () => {
    const { ws, adapter } = makeAdapter();
    const onStart = jest.fn();
    adapter.onCallStart(onStart);

    ws.emit(
      'message',
      connectEvent({
        did: '+5511800000000',
        caller: '+5511988887777',
        CPF: '123',
      }),
      false,
    );

    const identified = await adapter.waitForIdentification(100);
    expect(identified).toBe(true);
    expect(adapter.metadata.didNumber).toBe('+5511800000000');
    expect(adapter.metadata.callerNumber).toBe('+5511988887777');
    expect(adapter.metadata.customVariables?.CPF).toBe('123');

    await adapter.start();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('aceita PCM 16k binário inbound e repassa direto ao callback', () => {
    const { ws, adapter } = makeAdapter();
    const onAudio = jest.fn();
    adapter.onAudio(onAudio);

    ws.emit('message', connectEvent(), false);
    const pcm16k = Buffer.alloc(640, 0x11); // 320 amostras @16k
    ws.emit('message', pcm16k, true);

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0][0] as Buffer).toBe(pcm16k);
  });

  it('envia mídia outbound como frames binários PCM na taxa negociada', () => {
    jest.useFakeTimers();
    try {
      const { ws, adapter } = makeAdapter();
      ws.emit('message', connectEvent(), false);

      // 2920 bytes @24k → 487 amostras @16k = 974B → 1 frame de 640B + resto
      adapter.sendAudio(Buffer.alloc(2920, 0x22));
      jest.advanceTimersByTime(20);

      const binary = ws.sentBinary();
      expect(binary.length).toBe(1);
      expect(binary[0].length).toBe(640); // 320 amostras = 20ms @16k
      // Fade-in zera a primeira amostra; o resto é o padrão resampleado
      expect(binary[0].readInt16LE(0)).toBe(0);
      expect(binary[0].readInt16LE(100)).not.toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clearQueuedAudio envia {"action":"clear"} (buffer do Vonage)', () => {
    const { ws, adapter } = makeAdapter();
    ws.emit('message', connectEvent(), false);

    adapter.sendAudio(Buffer.alloc(2920, 0x11));
    adapter.clearQueuedAudio();

    const clear = ws.sentJson().filter((m) => m.action === 'clear');
    expect(clear.length).toBe(1);
  });

  it('propaga DTMF, trata websocket:hangup e hangup fecha o WS', () => {
    const { ws, adapter } = makeAdapter();
    const onDtmf = jest.fn();
    const onEnd = jest.fn();
    adapter.onDTMF(onDtmf);
    adapter.onCallEnd(onEnd);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'websocket:dtmf', digit: '#', duration: 200 }),
      ),
      false,
    );
    expect(onDtmf).toHaveBeenCalledWith('#');

    // Hangup pela IA fecha o WS
    adapter.hangup('ai_requested');
    expect(ws.closed).toBe(true);

    // websocket:hangup após o close não duplica o callback de fim de chamada
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ event: 'websocket:hangup' })),
      false,
    );
    expect(onEnd).toHaveBeenCalledTimes(1); // apenas o do hangup()
  });

  it('bufferiza mídia recebida antes de onAudio e entrega na ordem', () => {
    const { ws, adapter } = makeAdapter();
    ws.emit('message', connectEvent(), false);

    // Chega ANTES de onAudio (janela de setup da sessão)
    const a = Buffer.alloc(640, 0x21);
    const b = Buffer.alloc(640, 0x42);
    ws.emit('message', a, true);
    ws.emit('message', b, true);

    const onAudio = jest.fn();
    adapter.onAudio(onAudio);
    expect(onAudio).toHaveBeenCalledTimes(2);
    expect(onAudio.mock.calls[0][0] as Buffer).toBe(a);
    expect(onAudio.mock.calls[1][0] as Buffer).toBe(b);
  });
});
