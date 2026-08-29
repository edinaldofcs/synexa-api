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
  it('monta frame no formato real [type:1][len:2][payload] (res_audiosocket)', () => {
    const payload = Buffer.alloc(320, 0x42);
    const frame = buildAudioSocketFrame(AUDIOSOCKET_TYPES.AUDIO, payload);

    expect(frame.length).toBe(3 + 320);
    expect(frame.readUInt8(0)).toBe(AUDIOSOCKET_TYPES.AUDIO);
    expect(frame.readUInt16BE(1)).toBe(320);
    expect(frame.subarray(3).toString('hex')).toBe(payload.toString('hex'));
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

  it('parseia o frame UUID exatamente como o Asterisk envia (0x01 + 16 bytes)', () => {
    // ast_audiosocket_init escreve: [0x01][0x00][0x10][16 bytes de uuid]
    const raw = Buffer.concat([Buffer.from([0x01, 0x00, 0x10]), uuidBuffer(7)]);
    const parsed = parseAudioSocketFrames(raw);
    expect(parsed.frames.length).toBe(1);
    expect(parsed.frames[0].type).toBe(AUDIOSOCKET_TYPES.UUID);
    expect(parsed.frames[0].length).toBe(16);
    expect(parsed.rest.length).toBe(0);
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

  it('não insere padding de silêncio entre chunks e envia com pacing de 20ms', () => {
    jest.useFakeTimers();
    try {
      const socket = new net.Socket();
      const adapter = new AudioSocketAdapter(socket);
      const writes: Buffer[] = [];
      jest.spyOn(socket, 'write').mockImplementation((buf: unknown) => {
        writes.push(buf as Buffer);
        return true;
      });

      // 2920 bytes @24k (1460 amostras) → 487 amostras @8k = 974 bytes:
      // 3 frames completos (960) + 14 bytes de resto
      adapter.sendAudio(Buffer.alloc(2920, 0x11));
      // Pre-buffer (3 frames): nada sai antes
      jest.advanceTimersByTime(10);
      expect(audioFramesFrom(writes).length).toBe(0);
      // Pacing: 1 frame (20ms) por tick
      jest.advanceTimersByTime(15);
      expect(audioFramesFrom(writes).length).toBe(1);
      // Frame inteiro com o padrão original, exceto o fade-in inicial (~2ms)
      const first = audioFramesFrom(writes)[0];
      expect(first.length).toBe(3 + 320);
      const firstPayload = first.subarray(3);
      expect(firstPayload.readInt16LE(0)).toBe(0);
      expect(firstPayload.readInt16LE(2)).not.toBe(0);
      expect(firstPayload.subarray(32).every((v) => v === 0x11)).toBe(true);

      // Segundo chunk: resto 14 + 974 = 988 → 3 frames + 28 de resto.
      // Frame da junção começa com o resto (0x11) e termina em 0x22.
      adapter.sendAudio(Buffer.alloc(2920, 0x22));
      jest.advanceTimersByTime(80);
      const frames = audioFramesFrom(writes);
      // 1 (chunk1) + 4 ticks após o chunk2
      expect(frames.length).toBe(5);
      const junction = frames[3].subarray(3);
      expect(junction[13]).toBe(0x11);
      expect(junction[14]).toBe(0x22);
      expect(junction[319]).toBe(0x22);
      // Frames de áudio enviados não contêm padding de silêncio
      for (const f of frames) {
        expect(f.subarray(3).some((v) => v !== 0)).toBe(true);
      }

      // Pacer contínuo: após o último frame (F6), silêncio com cauda decaindo
      jest.advanceTimersByTime(60);
      const all = audioFramesFrom(writes);
      expect(all.length).toBe(8); // F6 + 2 ticks de silêncio
      expect(all[5].subarray(3).every((v) => v === 0x22)).toBe(true);
      // 1º frame de silêncio: decay do último sample (20 amostras), resto zero
      const decay = all[6].subarray(3);
      expect(decay.readInt16LE(0)).not.toBe(0);
      expect(decay.subarray(40).every((v) => v === 0)).toBe(true);
      // 2º frame de silêncio: silêncio puro
      expect(all[7].subarray(3).every((v) => v === 0)).toBe(true);

      // Retomada após silêncio: fade-in (~2ms) no primeiro frame
      adapter.sendAudio(Buffer.alloc(2920, 0x33));
      jest.advanceTimersByTime(20);
      const resumed = audioFramesFrom(writes)[8].subarray(3);
      expect(resumed.readInt16LE(0)).toBe(0);
      expect(resumed.readInt16LE(2)).not.toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clearQueuedAudio descarta a fila no barge-in e o pacer segue com silêncio', () => {
    jest.useFakeTimers();
    try {
      const socket = new net.Socket();
      const adapter = new AudioSocketAdapter(socket);
      const writes: Buffer[] = [];
      jest.spyOn(socket, 'write').mockImplementation((buf: unknown) => {
        writes.push(buf as Buffer);
        return true;
      });

      adapter.sendAudio(Buffer.alloc(2920, 0x11)); // 3 frames → pacer inicia
      jest.advanceTimersByTime(20); // 1 frame enviado
      adapter.sendAudio(Buffer.alloc(2920, 0x22)); // +3 frames (fila: 5)
      adapter.clearQueuedAudio();
      jest.advanceTimersByTime(60); // 3 ticks após o clear

      const frames = audioFramesFrom(writes);
      expect(frames.length).toBe(4);
      // O único frame reproduzido antes do clear: padrão 0x11 exceto fade-in;
      // depois do clear: 1º frame com decay do último sample, resto silêncio
      const f0 = frames[0].subarray(3);
      expect(f0.readInt16LE(0)).toBe(0);
      expect(f0.subarray(32).every((v) => v === 0x11)).toBe(true);
      const decay = frames[1].subarray(3);
      expect(decay.readInt16LE(0)).not.toBe(0);
      expect(decay.subarray(40).every((v) => v === 0)).toBe(true);
      for (const f of frames.slice(2)) {
        expect(f.subarray(3).every((v) => v === 0)).toBe(true);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  function audioFramesFrom(writes: Buffer[]): Buffer[] {
    return writes.filter(
      (b) => b.length >= 3 && b.readUInt8(0) === AUDIOSOCKET_TYPES.AUDIO,
    );
  }
});
