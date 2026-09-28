/** Read-only transition audit. Output contains references, never configured values. */
export interface VariableAuditReference {
  kind: string;
  id: string;
  client_id?: string;
  path: string;
  reason: string;
}
const formerConventions = new Set([
  'param',
  'cpf',
  'cliente_cpf',
  'cpf_cliente',
  'cnpj_cpf',
  'documento',
  'codigo',
  'nome',
  'nome_cliente',
  'cliente_nome',
  'nome_contato',
  'primeiro_nome',
  'telefone',
  'phone',
  'valor_original',
  'valor_divida',
  'valor_acordo',
  'acordo_id',
  'contrato',
  'numero_contrato',
  'dias_atraso',
  'empresa',
  'agent_name',
  'company_name',
  'cpc',
  'cpca',
  'is_right_party',
  'is_debt_presented',
  'is_agreement_reached',
  'is_promise_to_pay',
  'tem_ofertas',
]);
export function auditVariableConfiguration(
  kind: string,
  id: string,
  config: unknown,
  clientId?: string,
): VariableAuditReference[] {
  const references: VariableAuditReference[] = [];
  const add = (path: string, reason: string) =>
    references.push({ kind, id, client_id: clientId, path, reason });
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      const placeholders = [
        ...value.matchAll(/(?:\{\{|\[\[)([^}\]]+)(?:\}\}|\]\])/g),
      ].map((match) => match[1].trim().split('[')[0]);
      if (
        formerConventions.has(value) ||
        placeholders.some((key) => formerConventions.has(key))
      )
        add(path, 'former_name_convention_review');
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (formerConventions.has(key))
        add(child, 'former_name_convention_review');
      visit(entry, child);
    }
  };
  visit(config, '');
  return references;
}
