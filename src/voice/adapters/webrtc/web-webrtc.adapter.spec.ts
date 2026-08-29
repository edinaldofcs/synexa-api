import { WebSocket } from 'ws';
import { WebRtcAdapter } from './web-webrtc.adapter';

class FakeBrowserSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  close = jest.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.lastCloseCode = code;
    this.lastCloseReason = reason;
    this.emitClose?.();
  });
  terminate = jest.fn();
  lastCloseCode?: number;
  lastCloseReason?: string;
  private closeHandler: ((code: number) => void) | null = null;

  emitClose = () => {
    this.closeHandler?.(this.lastCloseCode ?? 1005);
  };

  on(event: string, handler: (...args: any[]) => void) {
    if (event === 'close') this.closeHandler = handler;
    if (event === 'error') this.errorHandler = handler;
    return this;
  }

  once(event: string, handler: (...args: any[]) => void) {
    if (event === 'open') handler();
    return this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  errorHandler: ((err: Error) => void) | null = null;
}

describe('WebRtcAdapter', () => {
  it('expõe identidade de canal web sob o contrato ITelephonyAdapter', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({
      id: 'conv-1',
      socket: socket as any,
      metadata: { callerName: 'Painel Web' },
    });

    expect(adapter.id).toBe('conv-1');
    expect(adapter.providerName).toBe('web_webrtc');
    expect(adapter.sampleRate).toBe(16000);
    expect(adapter.metadata.callerName).toBe('Painel Web');
  });

  it('sendAudio transmite frame JSON com o PCM em base64', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });

    const pcm = Buffer.from([1, 2, 3, 4]);
    adapter.sendAudio(pcm);

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.type).toBe('audio');
    expect(Buffer.from(frame.data, 'base64').equals(pcm)).toBe(true);
  });

  it('sendAudio ignora o envio quando o socket não está aberto', () => {
    const socket = new FakeBrowserSocket();
    socket.readyState = WebSocket.CLOSED;
    const adapter = new WebRtcAdapter({ socket: socket as any });

    adapter.sendAudio(Buffer.from([1, 2, 3]));

    expect(socket.sent).toHaveLength(0);
  });

  it('handleClientAudio entrega PCM 16-bit ao callback registrado via onAudio', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });
    const received: Buffer[] = [];
    adapter.onAudio((pcm) => received.push(pcm));

    const pcm = Buffer.from([9, 8, 7]);
    adapter.handleClientAudio(pcm.toString('base64'));

    expect(received).toHaveLength(1);
    expect(received[0].equals(pcm)).toBe(true);
  });

  it('handleClientAudio ignora frames vazios ou sem callback', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });

    expect(() => adapter.handleClientAudio('')).not.toThrow();

    const received: Buffer[] = [];
    adapter.onAudio((pcm) => received.push(pcm));
    adapter.handleClientAudio('');
    expect(received).toHaveLength(0);
  });

  it('mantém variáveis de canal em memória (sem PBX no navegador)', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });

    adapter.setVariable('status_atendimento', 'resolvido');
    expect(adapter.getVariable('status_atendimento')).toBe('resolvido');
    expect(adapter.getVariable('inexistente')).toBeUndefined();
  });

  it('hangup fecha o socket com código normal e dispara onCallEnd', async () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });
    const ended: (string | undefined)[] = [];
    adapter.onCallEnd((reason) => ended.push(reason));
    await adapter.start();

    adapter.hangup('concluido');

    expect(socket.close).toHaveBeenCalledWith(1000, 'concluido');
    expect(ended).toHaveLength(1);
  });

  it('onCallEnd dispara quando o navegador encerra a conexão', async () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });
    const ended: (string | undefined)[] = [];
    adapter.onCallEnd((reason) => ended.push(reason));
    await adapter.start();

    socket.lastCloseCode = 1001;
    socket.emitClose();

    expect(ended).toEqual(['1001']);
  });

  it('transferCall não é suportado no canal Web', async () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });

    await expect(adapter.transferCall('1002')).resolves.toBe(false);
  });

  it('clearQueuedAudio é um no-op seguro (playback é client-side)', () => {
    const socket = new FakeBrowserSocket();
    const adapter = new WebRtcAdapter({ socket: socket as any });
    expect(() => adapter.clearQueuedAudio()).not.toThrow();
  });
});
