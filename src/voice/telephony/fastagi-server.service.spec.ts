import {
  FastAgiServerService,
  isVoiceIngressIpAllowed,
  parseVoiceIngressAllowlist,
  voiceIngressSecretMatches,
} from './fastagi-server.service';

function makeService(config: Record<string, unknown>): FastAgiServerService {
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: any) => config[key] ?? defaultValue,
    ),
  } as any;
  return new FastAgiServerService(
    configService as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

describe('Voice ingress allowlist helpers', () => {
  it('parseVoiceIngressAllowlist separa CIDRs por virgula e ignora vazios', () => {
    expect(
      parseVoiceIngressAllowlist(' 10.0.0.0/8 , 192.168.1.0/24, ,'),
    ).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
    expect(parseVoiceIngressAllowlist(undefined)).toEqual([]);
  });

  it('allowlist vazia libera qualquer IP (modo dev)', () => {
    expect(isVoiceIngressIpAllowed('203.0.113.9', [])).toBe(true);
    expect(isVoiceIngressIpAllowed(undefined, [])).toBe(true);
  });

  it('valida IPv4 exato, CIDR /24 e /8', () => {
    const allowlist = ['10.0.0.0/8', '192.168.1.0/24'];
    expect(isVoiceIngressIpAllowed('10.20.30.40', allowlist)).toBe(true);
    expect(isVoiceIngressIpAllowed('192.168.1.55', allowlist)).toBe(true);
    expect(isVoiceIngressIpAllowed('192.168.2.1', allowlist)).toBe(false);
    expect(isVoiceIngressIpAllowed('11.0.0.1', allowlist)).toBe(false);
  });

  it('normaliza IPv6-mapped IPv4 e aceita IP exato sem mascara', () => {
    expect(
      isVoiceIngressIpAllowed('::ffff:192.168.1.10', ['192.168.1.0/24']),
    ).toBe(true);
    expect(isVoiceIngressIpAllowed('10.1.2.3', ['10.1.2.3'])).toBe(true);
    expect(isVoiceIngressIpAllowed(undefined, ['10.0.0.0/8'])).toBe(false);
  });

  it('shared secret: match exato, mismatch e ausente', () => {
    expect(voiceIngressSecretMatches('abc', 'abc')).toBe(true);
    expect(voiceIngressSecretMatches('wrong', 'abc')).toBe(false);
    expect(voiceIngressSecretMatches(undefined, 'abc')).toBe(false);
    expect(voiceIngressSecretMatches('', 'abc')).toBe(false);
  });

  it('recusa iniciar o servidor FastAGI em production sem allowlist (fail-closed)', () => {
    const service = makeService({
      FASTAGI_ENABLED: true,
      ENVIRONMENT: 'production',
      VOICE_INGRESS_ALLOWLIST: '',
    });
    expect(() => service.start()).toThrow(/VOICE_INGRESS_ALLOWLIST/);
  });
});
