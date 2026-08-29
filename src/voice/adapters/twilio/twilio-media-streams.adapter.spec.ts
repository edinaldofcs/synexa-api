import { G711Codec } from '../../audio/g711-codec.util';
import {
  TwilioMediaStreamsAdapter,
  TwilioMediaStreamsAdapterConfig,
} from './twilio-media-streams.adapter';

class FakeWebSocket {
  public readyState = 1; // OPEN
  public closed = false;
  public sent: string[] = [];
  private handlers: Record<string, Array<(...args: any[]) => void>> = {};

  public on(event: string, cb: (...args: any[]) => void): void {
    (this.handlers[event] ||= []).push(cb);
  }

  public emit(event: string, ...args: any[]): void {
    for (const cb of this.handlers[event] || []) cb(...args);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
  }

  public sentJson(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeAdapter(overrides?: Partial<TwilioMediaStreamsAdapterConfig>) {
  const ws = new FakeWebSocket();
  const adapter = new TwilioMediaStreamsAdapter({
    wsSocket: ws as any,
    metadata: { didNumber: '+5511999990000' },
    ...overrides,
  });
  return { ws, adapter };
}

/** Payload µ-law de 160 bytes (20ms) com todas as amostras codificando `sample` */
function mulawPayload(sample: number): string {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(sample, i * 2);
  return G711Codec.encodeUlaw(pcm).toString('base64');
}

describe('TwilioMediaStreamsAdapter', () => {
  it('identifica a stream no evento start e expõe customParameters', async () => {
    const { ws, adapter } = makeAdapter();
    const onStart = jest.fn();
    adapter.onCallStart(onStart);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: {
            streamSid: 'MZ123',
            callSid: 'CA987',
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
            customParameters: {
              did: '+5511800000000',
              caller: '+5511988887777',
              CPF_CLIENTE: '12345678900',
            },
          },
        }),
      ),
    );

    await adapter.waitForIdentification(100);
    expect(adapter.metadata.channelId).toBe('CA987');
    expect(adapter.metadata.didNumber).toBe('+5511800000000');
    expect(adapter.metadata.callerNumber).toBe('+5511988887777');
    expect(adapter.metadata.customVariables?.CPF_CLIENTE).toBe('12345678900');

    await adapter.start();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('decodifica mídia µ-law inbound para PCM 16k no callback', () => {
    const { ws, adapter } = makeAdapter();
    const onAudio = jest.fn();
    adapter.onAudio(onAudio);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'start', start: { streamSid: 'MZ1' } }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          media: { payload: mulawPayload(5000) },
        }),
      ),
    );

    expect(onAudio).toHaveBeenCalledTimes(1);
    const pcm16k = onAudio.mock.calls[0][0] as Buffer;
    expect(pcm16k.length).toBe(320 * 2); // 160 amostras 8k → 320 @16k
    // µ-law é lossy, mas 5000 deve voltar próximo (interpolação dobra amostras)
    expect(Math.abs(pcm16k.readInt16LE(100) - 5000)).toBeLessThan(400);
  });

  it('envia mídia outbound em JSON {event:media} com pacing e payload µ-law', () => {
    jest.useFakeTimers();
    try {
      const { ws, adapter } = makeAdapter();
      ws.emit(
        'message',
        Buffer.from(
          JSON.stringify({ event: 'start', start: { streamSid: 'MZ2' } }),
        ),
      );

      // 2920 bytes @24k → 487 amostras @8k = 3 frames (974B) + resto
      adapter.sendAudio(Buffer.alloc(2920, 0x22));
      jest.advanceTimersByTime(20);

      const media = ws.sentJson().filter((m) => m.event === 'media');
      expect(media.length).toBe(1);
      expect(media[0].streamSid).toBe('MZ2');
      const ulaw = Buffer.from(media[0].media.payload, 'base64');
      expect(ulaw.length).toBe(160); // 20ms µ-law @8k
      const decoded = G711Codec.decodeUlaw(ulaw);
      // µ-law é lossy, mas 8738 (0x2222) volta próximo; a amostra 0 vem a 0
      // pelo fade-in de retomada do pacer
      expect(decoded.readInt16LE(0)).toBe(0);
      expect(Math.abs(decoded.readInt16LE(100) - 8738)).toBeLessThan(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clearQueuedAudio envia {event:clear} para cortar o buffer do Twilio', () => {
    const { ws, adapter } = makeAdapter();
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'start', start: { streamSid: 'MZ3' } }),
      ),
    );

    adapter.sendAudio(Buffer.alloc(2920, 0x11));
    adapter.clearQueuedAudio();

    const clear = ws.sentJson().filter((m) => m.event === 'clear');
    expect(clear.length).toBe(1);
    expect(clear[0].streamSid).toBe('MZ3');
  });

  it('bufferiza mídia recebida antes de onAudio e entrega na ordem (sem perder o alô)', () => {
    const { ws, adapter } = makeAdapter();
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'start', start: { streamSid: 'MZ4' } }),
      ),
    );
    // Mídia chega ANTES de onAudio (janela de setup da sessão)
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          media: { payload: mulawPayload(5000) },
        }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          media: { payload: mulawPayload(6000) },
        }),
      ),
    );

    const onAudio = jest.fn();
    adapter.onAudio(onAudio);
    expect(onAudio).toHaveBeenCalledTimes(2);
    const first = onAudio.mock.calls[0][0] as Buffer;
    expect(Math.abs(first.readInt16LE(0) - 5000)).toBeLessThan(400);
    const second = onAudio.mock.calls[1][0] as Buffer;
    expect(Math.abs(second.readInt16LE(0) - 6000)).toBeLessThan(400);

    // Depois do drain, mídia nova vai direto ao callback
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          media: { payload: mulawPayload(7000) },
        }),
      ),
    );
    expect(onAudio).toHaveBeenCalledTimes(3);
  });

  it('encerra com callEnd no evento stop e no close do socket', () => {
    const { ws, adapter } = makeAdapter();
    const onEnd = jest.fn();
    adapter.onCallEnd(onEnd);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'stop',
          stop: { callSid: 'CA1', reason: 'call_ended' },
        }),
      ),
    );
    expect(onEnd).toHaveBeenCalledWith('twilio_stream_stop');

    // Segundo encerramento (via socket) não duplica callback
    ws.emit('close');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('propaga DTMF e hangup fecha o WebSocket', () => {
    const { ws, adapter } = makeAdapter();
    const onDtmf = jest.fn();
    adapter.onDTMF(onDtmf);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'dtmf',
          dtmf: { digit: '5', duration: '200' },
        }),
      ),
    );
    expect(onDtmf).toHaveBeenCalledWith('5');

    adapter.hangup('ai_requested');
    expect(ws.closed).toBe(true);
  });
});
