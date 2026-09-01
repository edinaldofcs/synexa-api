import {
  mergeApiReturnIntoState,
  aiSpeaksFirstEnabled,
  VOICE_GREETING_TURN,
} from './voice-runtime.util';

describe('mergeApiReturnIntoState', () => {
  it('espelha chaves do extract_data na RAIZ do estado (paridade com o texto)', () => {
    const state = mergeApiReturnIntoState(
      { user_transcript: 'quero negociar' },
      {
        returnedState: {
          valor_original: '1500.00',
          contrato: '123',
          dias_atraso: 45,
        },
      },
    );

    // na raiz — o que as condições de ativação referenciam
    expect(state.valor_original).toBe('1500.00');
    expect(state.contrato).toBe('123');
    expect(state.dias_atraso).toBe(45);
    // e o bloco retorno_api permanece (compat com condições legadas)
    expect((state.retorno_api as any).valor_original).toBe('1500.00');
    // estado anterior preservado
    expect(state.user_transcript).toBe('quero negociar');
  });

  it('aplica save_to_session por cima do retorno (paridade com o texto)', () => {
    const state = mergeApiReturnIntoState({}, {
      returnedState: { valor_original: '1500.00' },
      sessionSaves: { valor_original: '2000.00' },
    });
    expect(state.valor_original).toBe('2000.00');
  });

  it('grava apenas sessionSaves quando a API nao retorna dados extraiveis', () => {
    const state = mergeApiReturnIntoState({}, {
      returnedState: {},
      sessionSaves: { cpf_cliente: '123' },
    });
    expect(state.cpf_cliente).toBe('123');
    expect(state.retorno_api).toBeUndefined();
  });

  it('nao grava retorno_api vazio quando keepRetornoApi=false', () => {
    const state = mergeApiReturnIntoState({}, {
      returnedState: { a: 1 },
      keepRetornoApi: false,
    });
    expect(state.a).toBe(1);
    expect(state.retorno_api).toBeUndefined();
  });

  it('nao corrompe o estado com returnedState vazio', () => {
    const state = mergeApiReturnIntoState({ x: 1 }, { returnedState: {} });
    expect(state).toEqual({ x: 1 });
  });
});

describe('aiSpeaksFirstEnabled (IA fala primeiro)', () => {
  it('habilitado por padrao (agente sem transitions/capabilities)', () => {
    expect(aiSpeaksFirstEnabled({ service_step: 'x' })).toBe(true);
    expect(aiSpeaksFirstEnabled(null)).toBe(true);
    expect(aiSpeaksFirstEnabled(undefined)).toBe(true);
  });

  it('desliga explicitamente com ai_speaks_first=false', () => {
    expect(
      aiSpeaksFirstEnabled({
        transitions: { capabilities: { ai_speaks_first: false } },
      }),
    ).toBe(false);
  });

  it('mantem ligado com qualquer outro valor (incluido true)', () => {
    expect(
      aiSpeaksFirstEnabled({
        transitions: { capabilities: { ai_speaks_first: true } },
      }),
    ).toBe(true);
  });

  it('instrucao de greeting existe e orienta saudacao sem inventar dados', () => {
    expect(VOICE_GREETING_TURN).toContain('EVENTO DO SISTEMA');
    expect(VOICE_GREETING_TURN).toContain('saudação inicial');
    expect(VOICE_GREETING_TURN).toContain('Não invente dados');
  });
});
