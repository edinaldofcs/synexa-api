import { buildAgentPromptFromBlocks } from './agent-prompt-builder.util';

describe('buildAgentPromptFromBlocks', () => {
  it('should fallback to system_prompt if persona_blocks is not provided', () => {
    const prompt = buildAgentPromptFromBlocks({
      system_prompt: 'Prompt simples legado.',
    });
    expect(prompt).toBe('Prompt simples legado.');
  });

  it('should concatenate structured persona blocks in correct order', () => {
    const prompt = buildAgentPromptFromBlocks({
      system_prompt: 'Ignorado se houver blocks',
      persona_blocks: {
        identidade_persona: 'Você é a Clara, especialista financeira.',
        diretrizes_linguagem: 'Fale com tom formal e acolhedor.',
        dados_sistema: 'Taxa de juros de 1.5% a.m.',
        ofertas_disponiveis: 'Desconto de até 40% para pagamento à vista.',
        fluxo_conversa: '1. Saudação\n2. Identificação\n3. Negociação',
        regras_output: 'Sempre responda de forma concisa.',
        guardrails: 'Nunca revele senhas ou dados confidenciais.',
      },
    });

    expect(prompt).toContain(
      '## Identidade da Persona\nVocê é a Clara, especialista financeira.',
    );
    expect(prompt).toContain(
      '## Diretrizes de Linguagem & Sotaque\nFale com tom formal e acolhedor.',
    );
    expect(prompt).toContain('Fale com tom formal e acolhedor.');
    expect(prompt).toContain('Taxa de juros de 1.5% a.m.');
    expect(prompt).toContain('Desconto de até 40% para pagamento à vista.');
    expect(prompt).toContain('1. Saudação\n2. Identificação\n3. Negociação');
    expect(prompt).toContain('Sempre responda de forma concisa.');
    expect(prompt).toContain('Nunca revele senhas ou dados confidenciais.');
  });

  it('should interpolate custom and template variables from state', () => {
    const prompt = buildAgentPromptFromBlocks(
      {
        persona_blocks: {
          identidade_persona: 'Olá {NOME_CLIENTE}, seu saldo é {{saldo}}.',
          variaveis_customizadas: {
            '{NOME_CLIENTE}': 'cliente_nome',
          },
        },
      },
      {
        cliente_nome: 'Edinaldo',
        saldo: 'R$ 1.500,00',
      },
    );

    expect(prompt).toBe(
      '## Identidade da Persona\nOlá Edinaldo, seu saldo é R$ 1.500,00.',
    );
  });

  it('should resolve conditional blocks within persona_blocks based on state', () => {
    const prompt = buildAgentPromptFromBlocks(
      {
        persona_blocks: {
          identidade_persona: [
            { type: 'text', content: 'Você é a Sofia, consultora Synexa.' },
            {
              type: 'conditional',
              condition: {
                logic: 'AND',
                rules: [
                  {
                    variable: 'tipo_cliente',
                    operator: 'equals',
                    value: 'premium',
                  },
                  { variable: 'saldo_devedor', operator: 'gt', value: 0 },
                ],
              },
              then_blocks: [
                {
                  type: 'text',
                  content: 'Trate com atenção VIP. Ofereça 40% de desconto.',
                },
              ],
              else_blocks: [
                { type: 'text', content: 'Trate com tom cordial padrão.' },
              ],
            },
          ],
        },
      },
      {
        tipo_cliente: 'premium',
        saldo_devedor: 500,
      },
    );

    expect(prompt).toContain('## Identidade da Persona');
    expect(prompt).toContain('Você é a Sofia, consultora Synexa.');
    expect(prompt).toContain('Trate com atenção VIP. Ofereça 40% de desconto.');
    expect(prompt).not.toContain('Trate com tom cordial padrão.');
  });

  it('should resolve else block when conditional is false', () => {
    const prompt = buildAgentPromptFromBlocks(
      {
        persona_blocks: {
          identidade_persona: [
            { type: 'text', content: 'Você é a Sofia, consultora Synexa.' },
            {
              type: 'conditional',
              condition: {
                logic: 'AND',
                rules: [
                  {
                    variable: 'tipo_cliente',
                    operator: 'equals',
                    value: 'premium',
                  },
                ],
              },
              then_blocks: [
                { type: 'text', content: 'Trate com atenção VIP.' },
              ],
              else_blocks: [
                { type: 'text', content: 'Trate com tom cordial padrão.' },
              ],
            },
          ],
        },
      },
      {
        tipo_cliente: 'comum',
      },
    );

    expect(prompt).toContain('Trate com tom cordial padrão.');
    expect(prompt).not.toContain('Trate com atenção VIP.');
  });
});
