import { AudioSocketServerService } from './audiosocket-server.service';

function makeService(config: Record<string, unknown>): any {
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: any) => config[key] ?? defaultValue,
    ),
  } as any;
  return new AudioSocketServerService(
    configService as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

describe('AudioSocketServerService ingress security', () => {
  it('recusa iniciar em production sem VOICE_INGRESS_ALLOWLIST (fail-closed)', () => {
    const service = makeService({
      AUDIOSOCKET_ENABLED: true,
      ENVIRONMENT: 'production',
      VOICE_INGRESS_ALLOWLIST: '',
    });
    expect(() => service.start()).toThrow(/VOICE_INGRESS_ALLOWLIST/);
  });
});
