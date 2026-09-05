import { VoiceSessionFactory } from './voice-session.factory';

const buildFactory = (maxSessions: number) => {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'VOICE_MAX_SESSIONS' ? maxSessions : undefined,
    ),
  };
  const keyResolver = {
    resolveApiKey: jest.fn().mockResolvedValue(''),
  };
  return new VoiceSessionFactory(
    {} as any,
    configService as any,
    {} as any,
    {} as any,
    keyResolver as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
};

describe('VoiceSessionFactory - semaforo global de sessoes', () => {
  it('recusa aquisicao acima do limite e libera no release', () => {
    const factory = buildFactory(2);

    expect(factory.tryAcquireSession()).toBe(true);
    expect(factory.tryAcquireSession()).toBe(true);
    expect(factory.tryAcquireSession()).toBe(false);

    factory.releaseSession();
    expect(factory.tryAcquireSession()).toBe(true);
  });

  it('release nao derruba o contador abaixo de zero', () => {
    const factory = buildFactory(2);

    factory.releaseSession();
    factory.releaseSession();

    expect(factory.tryAcquireSession()).toBe(true);
    expect(factory.tryAcquireSession()).toBe(true);
  });

  it('create() recusa com erro claro antes de criar o provider Gemini', async () => {
    const factory = buildFactory(0);

    await expect(factory.create({ id: 'ch-1' } as any, null)).rejects.toThrow(
      'VOICE_MAX_SESSIONS',
    );
  });
});
