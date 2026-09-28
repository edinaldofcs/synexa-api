import { auditVariableConfiguration } from './variable-binding-audit.util';
describe('configuration transition audit', () => {
  it('lists references without disclosing values or inventing purposes', () => {
    const config = {
      prompt: 'Olá {{nome_cliente}}',
      extract_data: { cpf: 'person.document' },
      segredo: 'sensitive-value',
    };
    const before = JSON.stringify(config);
    const result = auditVariableConfiguration(
      'api',
      'api-id',
      config,
      'client-id',
    );
    expect(result.map((item) => item.path)).toEqual([
      'prompt',
      'extract_data.cpf',
    ]);
    expect(JSON.stringify(result)).not.toContain('sensitive-value');
    expect(JSON.stringify(result)).not.toContain('report_target');
    expect(JSON.stringify(config)).toBe(before);
  });
});
