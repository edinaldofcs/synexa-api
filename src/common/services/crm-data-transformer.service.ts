import { Injectable, Logger } from '@nestjs/common';

export type CrmRuleOperator =
  | 'pass_through'
  | 'exists'
  | 'not_exists'
  | 'is_not_empty'
  | '=='
  | '!='
  | '>='
  | '<='
  | '>'
  | '<'
  | 'includes';

export interface CrmDerivedFieldRule {
  target_column: string;
  type?: 'any' | 'boolean' | 'string' | 'number' | 'currency' | 'date';
  operator: CrmRuleOperator;
  source_field: string;
  compare_value?: unknown;
  return_if_true?: unknown;
  return_if_false?: unknown;
  fallback?: unknown;
}

export interface CrmOutputConfig {
  enabled?: boolean;
  operation_type?: string;
  standard_fields_mapping?: {
    document?: string;
    name?: string;
    phone?: string;
  };
  derived_fields?: CrmDerivedFieldRule[];
  include_unmapped_as_json?: boolean;
  unmapped_json_column_name?: string;
}

export interface CrmTransformedRecord {
  // Colunas Padronizadas Nativas
  id_sessao?: string | null;
  id_contato?: string | null;
  documento?: string | null;
  nome?: string | null;
  telefone?: string | null;
  canal?: string | null;
  status_conversa?: string | null;
  timestamp?: string;

  // Campos Derivados e Mapeados
  [key: string]: unknown;

  // Variáveis Livres Agrupadas em JSON
  dados_variaveis?: Record<string, unknown>;
}

@Injectable()
export class CrmDataTransformerService {
  private readonly logger = new Logger(CrmDataTransformerService.name);

  /**
   * Transforma o estado da sessão e metadados em um registro estruturado pronto para CRM.
   */
  transform(params: {
    sessionState: Record<string, unknown>;
    endUser?: {
      id?: string;
      name?: string | null;
      metadata?: unknown;
    } | null;
    conversation?: {
      id?: string;
      origin_channel?: string | null;
      status?: string | null;
      closed_at?: Date | string | null;
      metadata?: unknown;
    } | null;
    config?: CrmOutputConfig | null;
  }): CrmTransformedRecord {
    const { sessionState, endUser, conversation, config } = params;

    const userMeta = (endUser?.metadata as Record<string, unknown>) || {};
    const convMeta = (conversation?.metadata as Record<string, unknown>) || {};

    // 1. Extração de Colunas Padronizadas
    const id_sessao = conversation?.id || null;
    const id_contato =
      endUser?.id ||
      (this.getByPath(sessionState, 'external_user_id') as string) ||
      (convMeta.external_user_id as string) ||
      null;

    const documento =
      (this.getByPath(sessionState, 'cpf_cnpj') as string) ||
      (this.getByPath(sessionState, 'cpf') as string) ||
      (this.getByPath(sessionState, 'cnpj') as string) ||
      (this.getByPath(sessionState, 'document_number') as string) ||
      (userMeta.document_number as string) ||
      (userMeta.cpf as string) ||
      (userMeta.cnpj as string) ||
      null;

    const nome =
      (this.getByPath(sessionState, 'nome') as string) ||
      (this.getByPath(sessionState, 'nome_cliente') as string) ||
      endUser?.name ||
      null;

    const telefone =
      (this.getByPath(sessionState, 'telefone') as string) ||
      (this.getByPath(sessionState, 'phone') as string) ||
      (userMeta.phone as string) ||
      (userMeta.normalized_phone as string) ||
      null;

    const record: CrmTransformedRecord = {
      id_sessao,
      id_contato,
      documento,
      nome,
      telefone,
      canal: conversation?.origin_channel || 'webchat',
      status_conversa: conversation?.status || 'active',
      timestamp: new Date().toISOString(),
    };

    const mappedKeys = new Set<string>([
      'id_sessao',
      'id_contato',
      'documento',
      'nome',
      'telefone',
      'canal',
      'status_conversa',
      'timestamp',
      'cpf_cnpj',
      'cpf',
      'cnpj',
      'document_number',
      'phone',
      '_last_operation_type',
      '_variable_schema',
      'current_agent_id',
      'pending_agent_id',
    ]);

    // 2. Processamento de Campos Derivados por Regras
    const derivedRules = config?.derived_fields || [];
    for (const rule of derivedRules) {
      if (!rule.target_column || !rule.source_field) continue;

      mappedKeys.add(rule.target_column);
      mappedKeys.add(rule.source_field);

      const rawVal = this.resolveFieldValue(
        rule.source_field,
        sessionState,
        userMeta,
        convMeta,
      );

      let finalVal: unknown;
      if (rule.operator === 'pass_through') {
        finalVal =
          rawVal !== undefined && rawVal !== null && rawVal !== ''
            ? rawVal
            : rule.fallback !== undefined
              ? rule.fallback
              : null;
      } else {
        const isMatch = this.evaluateOperator(
          rule.operator,
          rawVal,
          rule.compare_value,
        );

        if (isMatch) {
          if (
            rule.return_if_true === '$value' ||
            rule.return_if_true === '$source_value'
          ) {
            finalVal = rawVal;
          } else {
            finalVal =
              rule.return_if_true !== undefined ? rule.return_if_true : rawVal;
          }
        } else {
          finalVal =
            rule.return_if_false !== undefined
              ? rule.return_if_false
              : rule.fallback !== undefined
                ? rule.fallback
                : null;
        }
      }

      // Aplica formatação de tipo se especificado
      record[rule.target_column] = this.castType(finalVal, rule.type);
    }

    // Regra Padrão Automática de Cobrança: se houver agreementId na sessão, deriva promessa se não houver regra explícita
    if (!('promessa' in record)) {
      const agreementId =
        this.getByPath(sessionState, 'agreementId') ||
        this.getByPath(sessionState, 'agreement_id') ||
        this.getByPath(sessionState, 'id_acordo');

      if (
        agreementId !== undefined &&
        agreementId !== null &&
        agreementId !== ''
      ) {
        record['promessa'] = true;
        record['id_acordo'] = String(agreementId);
        mappedKeys.add('agreementId');
        mappedKeys.add('agreement_id');
        mappedKeys.add('id_acordo');
      }
    }

    // 3. Coleta de Variáveis Restantes no JSONB `dados_variaveis`
    const includeUnmapped = config?.include_unmapped_as_json !== false;
    if (includeUnmapped) {
      const unmappedColName =
        config?.unmapped_json_column_name || 'dados_variaveis';
      const unmapped: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(sessionState)) {
        if (!mappedKeys.has(key) && !key.startsWith('_')) {
          unmapped[key] = value;
        }
      }

      record[unmappedColName] = unmapped;
    }

    return record;
  }

  private resolveFieldValue(
    sourcePath: string,
    sessionState: Record<string, unknown>,
    userMeta: Record<string, unknown>,
    convMeta: Record<string, unknown>,
  ): unknown {
    const cleanPath = sourcePath.replace(/^(session\.|state\.)/, '');

    if (sourcePath.startsWith('end_user.')) {
      return this.getByPath(userMeta, sourcePath.replace('end_user.', ''));
    }

    if (sourcePath.startsWith('conversation.')) {
      return this.getByPath(convMeta, sourcePath.replace('conversation.', ''));
    }

    const fromState = this.getByPath(sessionState, cleanPath);
    if (fromState !== undefined) return fromState;

    return this.getByPath(sessionState, sourcePath);
  }

  private evaluateOperator(
    operator: CrmRuleOperator,
    value: unknown,
    compareVal?: unknown,
  ): boolean {
    switch (operator) {
      case 'exists':
      case 'is_not_empty':
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        return true;

      case 'not_exists':
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') return value.trim().length === 0;
        if (Array.isArray(value)) return value.length === 0;
        return false;

      case '==':
        return value == compareVal;

      case '!=':
        return value != compareVal;

      case '>=':
        return Number(value) >= Number(compareVal);

      case '<=':
        return Number(value) <= Number(compareVal);

      case '>':
        return Number(value) > Number(compareVal);

      case '<':
        return Number(value) < Number(compareVal);

      case 'includes':
        if (Array.isArray(value)) {
          return value.includes(compareVal);
        }
        return String(value || '').includes(String(compareVal || ''));

      default:
        return false;
    }
  }

  private castType(
    value: unknown,
    type?: 'any' | 'boolean' | 'string' | 'number' | 'currency' | 'date',
  ): unknown {
    if (value === null || value === undefined) return value;
    if (type === 'any') return value;

    switch (type) {
      case 'boolean':
        if (typeof value === 'boolean') return value;
        return (
          value === true || value === 'true' || value === 1 || value === '1'
        );

      case 'number': {
        const num = Number(value);
        return isNaN(num) ? value : num;
      }

      case 'currency': {
        const num =
          typeof value === 'number'
            ? value
            : Number(
                String(value)
                  .replace(',', '.')
                  .replace(/[^\d.]/g, ''),
              );
        return isNaN(num) ? value : Number(num.toFixed(2));
      }

      case 'string':
        return String(value);

      case 'date':
        return String(value);

      default:
        return value;
    }
  }

  private getByPath(obj: Record<string, unknown>, path: string): unknown {
    if (!path || !obj) return undefined;
    const parts = path.split('.');
    let curr: any = obj;

    for (const part of parts) {
      if (curr === null || curr === undefined) return undefined;
      curr = curr[part];
    }
    return curr;
  }
}
