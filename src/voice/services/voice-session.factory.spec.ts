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

  describe('concorrência por bot (max_concurrent_calls)', () => {
    it('limita chamadas simultâneas para um bot específico', () => {
      const factory = buildFactory(10);
      const botA = 'bot-uuid-1';

      expect(factory.tryAcquireSession(botA, 2)).toBe(true);
      expect(factory.getActiveSessionsCount(botA)).toBe(1);

      expect(factory.tryAcquireSession(botA, 2)).toBe(true);
      expect(factory.getActiveSessionsCount(botA)).toBe(2);

      // Terceira chamada para o mesmo bot excede o limite de 2
      expect(factory.tryAcquireSession(botA, 2)).toBe(false);
      expect(factory.getActiveSessionsCount(botA)).toBe(2);

      // Outro bot com capacidade pode alocar normalmente
      const botB = 'bot-uuid-2';
      expect(factory.tryAcquireSession(botB, 5)).toBe(true);
      expect(factory.getActiveSessionsCount(botB)).toBe(1);

      // Libera slot do botA e tenta novamente
      factory.releaseSession(botA);
      expect(factory.getActiveSessionsCount(botA)).toBe(1);
      expect(factory.tryAcquireSession(botA, 2)).toBe(true);
    });

    it('trata limite null, 0 ou ausente como ilimitado no bot (respeitando teto global)', () => {
      const factory = buildFactory(3);
      const bot = 'bot-unlimited';

      expect(factory.tryAcquireSession(bot, null)).toBe(true);
      expect(factory.tryAcquireSession(bot, 0)).toBe(true);
      expect(factory.tryAcquireSession(bot, undefined)).toBe(true);
      // Teto global atingido (3/3)
      expect(factory.tryAcquireSession(bot, null)).toBe(false);
    });

    it('create() recusa chamada quando limite do bot for atingido', async () => {
      const factory = buildFactory(10);
      const botId = 'bot-full';

      // Ocupa 1 slot (limite = 1)
      expect(factory.tryAcquireSession(botId, 1)).toBe(true);

      const route = {
        client_id: botId,
        client: { id: botId, max_concurrent_calls: 1 },
      };

      await expect(
        factory.create({ id: 'ch-2' } as any, route as any),
      ).rejects.toThrow(
        'Limite de chamadas simultâneas atingido para este bot',
      );
    });

    it('simula 15 ligações simultâneas para um bot com limite 10: aceita 10 e bloqueia as 5 excedentes', () => {
      const factory = buildFactory(50); // teto global 50 para isolar o limite do bot
      const botId = 'bot-limite-10';
      const maxLimit = 10;

      const resultados: boolean[] = [];

      // Dispara 15 tentativas simultâneas para o mesmo bot
      for (let i = 1; i <= 15; i++) {
        const aceito = factory.tryAcquireSession(botId, maxLimit);
        resultados.push(aceito);
      }

      // As 10 primeiras chamadas devem ser aceitas com sucesso
      expect(resultados.slice(0, 10)).toEqual(new Array(10).fill(true));
      expect(factory.getActiveSessionsCount(botId)).toBe(10);

      // As 5 chamadas seguintes (11 a 15) devem ser estritamente bloqueadas
      expect(resultados.slice(10, 15)).toEqual(new Array(5).fill(false));
      expect(factory.getActiveSessionsCount(botId)).toBe(10);

      // Verificação detalhada da 11ª chamada rejeitada
      const check11 = factory.checkAcquireSession(botId, maxLimit);
      expect(check11.allowed).toBe(false);
      expect(check11.reason).toBe('BOT_LIMIT_EXCEEDED');
      expect(check11.currentBot).toBe(10);
      expect(check11.maxBot).toBe(10);

      // Desconecta 3 chamadas
      factory.releaseSession(botId);
      factory.releaseSession(botId);
      factory.releaseSession(botId);
      expect(factory.getActiveSessionsCount(botId)).toBe(7);

      // Agora 3 novas chamadas conseguem entrar
      expect(factory.tryAcquireSession(botId, maxLimit)).toBe(true);
      expect(factory.tryAcquireSession(botId, maxLimit)).toBe(true);
      expect(factory.tryAcquireSession(botId, maxLimit)).toBe(true);
      expect(factory.getActiveSessionsCount(botId)).toBe(10);

      // A 4ª tentativa volta a ser bloqueada
      expect(factory.tryAcquireSession(botId, maxLimit)).toBe(false);
    });
  });
});
