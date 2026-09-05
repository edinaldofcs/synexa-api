import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { VoiceGateway } from './voice.gateway';

class FakeClientSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  handshakeRequest?: any;
  close = jest.fn((code: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  });

  send(payload: string) {
    this.sent.push(payload);
  }
}

function makeGateway(config: Record<string, unknown> = {}, redis?: any) {
  const voiceAuthService = {
    authenticateSession: jest
      .fn()
      .mockRejectedValue(new Error('session required')),
    resolveClientId: jest.fn(),
  };
  const redisService = redis ?? {
    getClient: () => ({
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    }),
  };
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: any) => config[key] ?? defaultValue,
    ),
  };
  const gateway = new VoiceGateway(
    {} as any,
    voiceAuthService as any,
    {} as any,
    {} as any,
    {} as any,
    configService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      flushAiBuffer: jest.fn(),
      persistSessionTelemetry: jest.fn(),
      persistConversationState: jest.fn(),
      buildTelemetryPayload: jest.fn().mockReturnValue(null),
    } as any,
    redisService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return {
    gateway,
    voiceAuthService,
    configService,
  };
}

describe('VoiceGateway security', () => {
  it('rejects a start message without a session cookie', async () => {
    const client = new FakeClientSocket();
    const { gateway, voiceAuthService } = makeGateway();

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

  it('recusa handshake sem Origin em production', () => {
    const { gateway } = makeGateway({ ENVIRONMENT: 'production' });
    const client = new FakeClientSocket();
    (client as any).handshakeRequest = { headers: {} };

    gateway.handleConnection(client as any);

    expect(client.close).toHaveBeenCalledWith(1008, 'Origin not allowed');
    expect(
      client.sent.some((payload) => payload.includes('VOICE_AUTH_REQUIRED')),
    ).toBe(false);
  });

  it('aceita handshake sem Origin fora de production', () => {
    const { gateway } = makeGateway({ ENVIRONMENT: 'development' });
    const client = new FakeClientSocket();
    expect(() => gateway.handleConnection(client as any)).not.toThrow();
    expect(client.close).not.toHaveBeenCalled();
    client.close(1000);
  });

  it('fecha conexões pre-auth acima do limite por IP (Redis INCR)', async () => {
    const { gateway } = makeGateway(
      { VOICE_MAX_PREAUTH_PER_IP: 10 },
      {
        getClient: () => ({
          incr: jest.fn().mockResolvedValue(11),
          expire: jest.fn().mockResolvedValue(1),
        }),
      },
    );
    const client = new FakeClientSocket();
    gateway.handleConnection(client as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.close).toHaveBeenCalledWith(1013, 'Too many connections');
  });

  it('identificação por IP usa a janela de 60s no Redis (key voice:preauth)', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const expire = jest.fn().mockResolvedValue(1);
    const { gateway } = makeGateway(
      {},
      { getClient: () => ({ incr, expire }) },
    );
    const client = new FakeClientSocket();
    (client as any).handshakeRequest = {
      headers: {},
      socket: { remoteAddress: '10.1.2.3' },
    };
    gateway.handleConnection(client as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(incr).toHaveBeenCalledWith('voice:preauth:10.1.2.3');
    expect(expire).toHaveBeenCalledWith('voice:preauth:10.1.2.3', 60);
    expect(client.close).not.toHaveBeenCalled();
    client.close(1000);
  });
});
