import {
  resolveDynamicSystemVariable,
  resolvePromptTemplateString,
  addBusinessDays,
} from './prompt-variables.util';

describe('prompt-variables.util', () => {
  // Test reference date: Friday, August 21, 2026 14:30:00 UTC
  // In America/Sao_Paulo (UTC-3), it is 11:30:00 (Friday)
  const fixedDate = new Date('2026-08-21T14:30:00.000Z');

  describe('resolveDynamicSystemVariable', () => {
    it('resolves hoje and offsets', () => {
      const hoje = resolveDynamicSystemVariable('hoje', fixedDate);
      expect(hoje).toBe('21/08/2026');

      const hojePlus1 = resolveDynamicSystemVariable('hoje+1', fixedDate);
      expect(hojePlus1).toBe('22/08/2026');

      const hojeMinus1 = resolveDynamicSystemVariable('hoje-1', fixedDate);
      expect(hojeMinus1).toBe('20/08/2026');
    });

    it('resolves hora_atual and data_hora_atual', () => {
      const hora = resolveDynamicSystemVariable('hora_atual', fixedDate);
      expect(hora).toBe('11:30');

      const dataHora = resolveDynamicSystemVariable('data_hora_atual', fixedDate);
      expect(dataHora).toBe('21/08/2026 às 11:30');
    });

    it('resolves dia_semana', () => {
      const dia = resolveDynamicSystemVariable('dia_semana', fixedDate);
      expect(dia).toBe('sexta-feira');

      const diaPlus1 = resolveDynamicSystemVariable('dia_semana+1', fixedDate);
      expect(diaPlus1).toBe('sábado');
    });

    it('resolves dias_uteis and skips weekends', () => {
      // Friday + 1 business day should be Monday (24/08/2026)
      const proximoDiaUtil = resolveDynamicSystemVariable('dias_uteis+1', fixedDate);
      expect(proximoDiaUtil).toBe('24/08/2026');

      const doisDiasUteis = resolveDynamicSystemVariable('dias_uteis+2', fixedDate);
      expect(doisDiasUteis).toBe('25/08/2026');
    });

    it('resolves proximo_dia_util and eh_dia_util', () => {
      const proximo = resolveDynamicSystemVariable('proximo_dia_util', fixedDate);
      expect(proximo).toBe('24/08/2026');

      const ehUtil = resolveDynamicSystemVariable('eh_dia_util', fixedDate);
      expect(ehUtil).toBe('sim');

      const tipoDia = resolveDynamicSystemVariable('tipo_dia_hoje', fixedDate);
      expect(tipoDia).toBe('dia útil');
    });

    it('resolves mes_atual, ano_atual and hoje_extenso', () => {
      const mes = resolveDynamicSystemVariable('mes_atual', fixedDate);
      expect(mes).toBe('agosto');

      const ano = resolveDynamicSystemVariable('ano_atual', fixedDate);
      expect(ano).toBe('2026');

      const extenso = resolveDynamicSystemVariable('hoje_extenso', fixedDate);
      expect(extenso).toBe('21 de agosto de 2026');
    });

    it('resolves saudacao_tempo', () => {
      // At 11:30 it is 'Bom dia'
      const saudacao = resolveDynamicSystemVariable('saudacao_tempo', fixedDate);
      expect(saudacao).toBe('Bom dia');

      // Test afternoon date: 15:00 Sao Paulo time (18:00 UTC)
      const afternoonDate = new Date('2026-08-21T18:00:00.000Z');
      const saudacaoTarde = resolveDynamicSystemVariable('saudacao_tempo', afternoonDate);
      expect(saudacaoTarde).toBe('Boa tarde');
    });
  });

  describe('resolvePromptTemplateString', () => {
    it('replaces system and custom variables seamlessly', () => {
      const template =
        'Olá [[nome_cliente]]! [[saudacao_tempo]], hoje é [[dia_semana]] ([[hoje]]), e seu boleto vence em [[dias_uteis+3]]. Horário de atendimento: [[hora_atual]].';
      const variables = {
        nome_cliente: 'Carlos Silva',
      };

      const result = resolvePromptTemplateString(template, variables, fixedDate);
      expect(result).toBe(
        'Olá Carlos Silva! Bom dia, hoje é sexta-feira (21/08/2026), e seu boleto vence em 26/08/2026. Horário de atendimento: 11:30.',
      );
    });

    it('preserves unknown variables without error', () => {
      const template = 'Campo desconhecido: [[campo_inexistente]].';
      const result = resolvePromptTemplateString(template, {}, fixedDate);
      expect(result).toBe('Campo desconhecido: [[campo_inexistente]].');
    });
  });
});
