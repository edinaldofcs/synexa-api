import net from 'net';
import {
  AudioSocketAdapter,
  AUDIOSOCKET_TYPES,
  buildAudioSocketFrame,
  parseAudioSocketFrames,
} from './audiosocket.adapter';

function uuidBuffer(value = 1): Buffer {
  const buf = Buffer.alloc(16, 0);
  buf.writeUInt32BE(value, 0);
  return buf;
}

describe('AudioSocket framing', () => {
  it('monta frame com header UUID + type + length', () => {
    const payload = Buffer.alloc(320, 0x42);
    const frame = buildAudioSocketFrame(
      AUDIOSOCKET_TYPES.AUDIO,
      payload,
      uuidBuffer(),
    );

    expect(frame.length).toBe(20 + 320);
    expect(frame.readUInt16BE(16)).toBe(AUDIOSOCKET_TYPES.AUDIO);
    expect(frame.readUInt16BE(18)).toBe(320);
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(1);
  });

  it('parseia frames concatenados e mantém fragmento parcial no resto', () => {
    const p1 = Buffer.alloc(10, 0xaa);
    const p2 = Buffer.alloc(5, 0xbb);
    const f1 = buildAudioSocketFrame(AUDIOSOCKET_TYPES.AUDIO, p1);
    const f2 = buildAudioSocketFrame(AUDIOSOCKET_TYPES.DTMF, p2);
    const merged = Buffer.concat([f1, f2]);
    // fragmenta f2 ao meio
    const partial = Buffer.concat([f1, f2.subarray(0, f2.length - 2)]);

    const complete = parseAudioSocketFrames(merged);
    expect(complete.frames.length).toBe(2);
    expect(complete.frames[0].type).toBe(AUDIOSOCKET_TYPES.AUDIO);
    expect(complete.frames[1].type).toBe(AUDIOSOCKET_TYPES.DTMF);
    expect(complete.rest.length).toBe(0);

    const fragmented = parseAudioSocketFrames(partial);
    expect(fragmented.frames.length).toBe(1);
    expect(fragmented.rest.length).toBe(f2.length - 2);
  });
});

describe('AudioSocketAdapter', () => {
  it('identifica canal pelo frame UUID e dispara callbacks de DTMF/áudio', () => {
    const socket = new net.Socket();
    const adapter = new AudioSocketAdapter(socket);

    const onAudio = jest.fn();
    const onDtmf = jest.fn();
    adapter.onAudio(onAudio);
    adapter.onDTMF(onDtmf);

    // UUID + DTMF "9" + áudio SLIN 8k (32 samples)
    const pcm8k = Buffer.alloc(64, 0x00);
    const inbound = Buffer.concat([
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.UUID, uuidBuffer(7)),
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.DTMF, Buffer.from('9')),
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.AUDIO, pcm8k),
    ]);
    socket.emit('data', inbound);

    expect(adapter.metadata.channelId).toBeDefined();
    expect(onDtmf).toHaveBeenCalledWith('9');
    expect(onAudio).toHaveBeenCalledTimes(1); // apenas o frame de áudio
    expect(adapter.metadata.channelId as string).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('converte áudio SLIN 8k recebido para PCM 16k no callback', () => {
    const socket = new net.Socket();
    const adapter = new AudioSocketAdapter(socket);
    const onAudio = jest.fn();
    adapter.onAudio(onAudio);

    const samples = new Int16Array(160); // 20ms @8k => 320 bytes
    for (let i = 0; i < samples.length; i++) samples[i] = 1000;
    const audioPayload = Buffer.from(samples.buffer);
    socket.emit(
      'data',
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.UUID, uuidBuffer()),
    );
    socket.emit(
      'data',
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.AUDIO, audioPayload),
    );

    expect(onAudio).toHaveBeenCalledWith(expect.any(Buffer));
    const out = onAudio.mock.calls[0][0] as Buffer;
    // resample dobra a amostragem: ~320 samples @16k
    expect(out.length / 2).toBeGreaterThanOrEqual(300);
  });

  it('encaminha TERMINATE como fim de chamada', () => {
    const socket = new net.Socket();
    const adapter = new AudioSocketAdapter(socket);
    const onEnd = jest.fn();
    adapter.onCallEnd(onEnd);

    socket.emit(
      'data',
      buildAudioSocketFrame(AUDIOSOCKET_TYPES.UUID, uuidBuffer(9)),
    );
    socket.emit('data', buildAudioSocketFrame(AUDIOSOCKET_TYPES.TERMINATE));

    expect(adapter.metadata.channelId).toBeDefined();
    expect((adapter as any).isClosed).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('audiosocket_terminate');
  });
});
