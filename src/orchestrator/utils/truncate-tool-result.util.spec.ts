import { truncateToolResult } from './truncate-tool-result.util';

describe('truncateToolResult', () => {
  it('retorna o JSON original quando abaixo do limite', () => {
    const result = { ok: true, data: 'pequeno' };
    expect(truncateToolResult(result)).toBe(JSON.stringify(result));
  });

  it('trunca resultado acima de maxBytes com preview e dropped', () => {
    const big = { data: 'x'.repeat(10000) };
    const truncated = truncateToolResult(big, 4096);
    const parsed = JSON.parse(truncated);

    expect(parsed.__truncated).toBe(true);
    expect(parsed.preview).toContain('data');
    expect(parsed.dropped).toBeGreaterThan(0);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThan(4096);
  });

  it('preserva chaves top-level com valores string curtos', () => {
    const big = { cep: '81450718', nome: 'Joao', blob: 'x'.repeat(10000) };
    const parsed = JSON.parse(truncateToolResult(big, 4096));

    expect(parsed.__truncated).toBe(true);
    expect(parsed.keys.cep).toBe('81450718');
    expect(parsed.keys.nome).toBe('Joao');
  });

  it('respeita maxBytes customizado', () => {
    const big = { data: 'a'.repeat(1000) };
    const truncated = truncateToolResult(big, 100);

    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThan(2500);
    expect(JSON.parse(truncated).__truncated).toBe(true);
  });

  it('lida com resultados não serializáveis sem lançar', () => {
    const circular: any = { self: null };
    circular.self = circular;
    const truncated = truncateToolResult(circular, 100);
    expect(() => JSON.parse(truncated)).not.toThrow();
  });
});
