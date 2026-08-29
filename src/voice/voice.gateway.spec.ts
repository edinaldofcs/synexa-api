import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { VoiceGateway } from './voice.gateway';

class FakeClientSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  close = jest.fn((code: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  });

  send(payload: string) {
    this.sent.push(payload);
  }
}

describe('VoiceGateway security', () => {
  it('rejects a start message without a session cookie', async () => {
    const client = new FakeClientSocket();
    const voiceAuthService = {
      authenticateSession: jest
        .fn()
        .mockRejectedValue(new Error('session required')),
      resolveClientId: jest.fn(),
    };
    const gateway = new VoiceGateway(
      {} as any,
      voiceAuthService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        flushAiBuffer: jest.fn(),
        persistSessionTelemetry: jest.fn(),
        buildTelemetryPayload: jest.fn().mockReturnValue(null),
      } as any,
    );

    gateway.handleConnection(client as any);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'start' })));
    await new Promise((resolve) => setImmediate(resolve));

    expect(voiceAuthService.authenticateSession).toHaveBeenCalledWith('');
    expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'error',
      code: 'VOICE_AUTH_REQUIRED',
      message: 'Autenticação necessária para iniciar a sessão de voz.',
    });
    expect(client.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });
});
