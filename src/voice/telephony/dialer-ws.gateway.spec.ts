import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { DialerWsIngress } from './dialer-ws.gateway';

class FakeWs extends EventEmitter {
  handshakeRequest: any;
  close = jest.fn((code?: number) => {
    this.emit('close', code);
  });
}

function makeGateway(
  config: Record<string, unknown>,
  resolveBySecretHash: jest.Mock = jest.fn().mockResolvedValue(null),
): any {
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: any) => config[key] ?? defaultValue,
    ),
  } as any;
  return new DialerWsIngress(
    configService as any,
    { create: jest.fn() } as any,
    { resolveBySecretHash } as any,
    {} as any,
  );
}

describe('DialerWsIngress security', () => {
  it('recusa subir sem TELEPHONY_WS_TOKEN_PEPPER em production', () => {
    expect(
      () =>
        makeGateway(
          {
            ENVIRONMENT: 'production',
            TELEPHONY_WS_TOKEN_PEPPER: '',
          },
          jest.fn(),
        ),
    ).toThrow(/TELEPHONY_WS_TOKEN_PEPPER/);
  });

  it('inicia fora de production sem pepper', () => {
    expect(() =>
      makeGateway(
        {
          ENVIRONMENT: 'development',
          TELEPHONY_WS_TOKEN_PEPPER: '',
        },
        jest.fn(),
      ),
    ).not.toThrow();
  });

  it('recusa token via query string quando TELEPHONY_WS_TOKEN_IN_QUERY != true', async () => {
    const gateway = makeGateway({ ENVIRONMENT: 'development' }, jest.fn());
    const client = new FakeWs();
    client.handshakeRequest = {
      url: '/ws/dialer?provider=callflex&token=abc123',
      headers: {},
    };

    await gateway.handleConnection(client as any);

    expect(client.close).toHaveBeenCalledWith(4401, 'unauthorized');
  });

  it('usa o token do header x-telephony-token e ignora o da query', async () => {
    const resolveBySecretHash = jest.fn().mockResolvedValue(null);
    const gateway = makeGateway(
      { ENVIRONMENT: 'development', TELEPHONY_WS_TOKEN_PEPPER: 'pepper' },
      resolveBySecretHash,
    );
    const client = new FakeWs();
    client.handshakeRequest = {
      url: '/ws/dialer?provider=callflex&token=SHOULD_BE_IGNORED',
      headers: { 'x-telephony-token': 'header-token' },
    };

    await gateway.handleConnection(client as any);

    const expectedHash = createHash('sha256')
      .update('header-tokenpepper')
      .digest('hex');
    expect(resolveBySecretHash).toHaveBeenCalledWith(expectedHash);
  });
});
