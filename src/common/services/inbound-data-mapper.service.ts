import { validateVariableDefinitions } from '../utils/extraction-validation.util';
import {
  readVariable,
  variableKey,
  isBusinessVariable,
} from '../utils/session-variables.util';
import { Injectable, Logger } from '@nestjs/common';

export type InboundTransformType =
  | 'text'
  | 'cpf_cnpj'
  | 'phone'
  | 'currency'
  | 'date'
  | 'uppercase'
  | 'lowercase'
  | 'number'
  | 'boolean'
  | 'last_chars'
  | 'first_chars'
  | 'mask_cpf'
  | 'substring';

export type InboundChannelSource =
  | 'all'
  | 'voice'
  | 'webhook'
  | 'api'
  | 'whatsapp'
  | 'webchat'
  | 'external_system';

export interface InboundMappingRule {
  id?: string;
  source_channel?: InboundChannelSource;
  source_field: string;
  target_variable: string;
  transform?: InboundTransformType;
  char_count?: number;
  only_digits?: boolean;
  slice_start?: number;
  slice_length?: number;
  default_value?: string;
  description?: string;
}

export interface DefaultSessionVariable {
  id?: string;
  key: string;
  value: string;
  description?: string;
}

export interface InboundMappingConfig {
  enabled?: boolean;
  preserve_unmapped?: boolean;
  rules?: InboundMappingRule[];
  default_variables?: DefaultSessionVariable[] | Record<string, unknown>;
}

@Injectable()
export class InboundDataMapperService {
  private readonly logger = new Logger(InboundDataMapperService.name);

  /**
   * Mapeia dados brutos de entrada (Discador, Telefonia, Webhooks, APIs ou Sistemas Externos)
   * para variáveis padronizadas da sessão com base nas regras do cliente.
   */
  mapInboundData(
    rawData: Record<string, unknown> | null | undefined,
    config: InboundMappingConfig | null | undefined,
    channel?: string,
  ): Record<string, unknown> {
    const mappedState: Record<string, unknown> = {};
    const defaults = config?.default_variables;
    for (const [key, value] of Array.isArray(defaults)
      ? defaults.map((item) => [item.key, item.value] as const)
      : Object.entries(defaults || {})) {
      const clean = variableKey(key);
      if (isBusinessVariable(clean)) mappedState[clean] = value;
    }
    const raw =
      rawData && typeof rawData === 'object' && !Array.isArray(rawData)
        ? rawData
        : {};
    const rules = config?.enabled === false ? [] : config?.rules || [];
    validateVariableDefinitions(
      rules.map((rule) => ({
        key: rule.target_variable,
        report_target: (rule as unknown as Record<string, unknown>)
          .report_target,
      })),
    );
    const normalized = (channel || 'all').toLowerCase();
    const appliedSources = new Set<string>();
    const explicitTargets = new Set<string>();
    for (const rule of rules) {
      const sourceChannel = rule.source_channel || 'all';
      const matches =
        sourceChannel === 'all' ||
        sourceChannel === normalized ||
        (sourceChannel === 'voice' &&
          [
            'voice',
            'telephony',
            'fastagi',
            'callflex',
            'asterisk',
            'sip',
            'audiosocket',
            'asterisk_fastagi',
            'webrtc',
            'twilio',
            'vonage',
          ].includes(normalized)) ||
        (['webhook', 'api', 'external_system'].includes(sourceChannel) &&
          ['webhook', 'api', 'external_system'].includes(normalized));
      if (!matches) continue;
      let value = readVariable(raw, rule.source_field);
      appliedSources.add(variableKey(rule.source_field).split('.')[0]);
      if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && !value.trim())
      )
        value = rule.default_value;
      if (value === undefined || value === null || value === '') continue;
      value = this.applyTransformation(value, rule.transform, rule);
      const target = variableKey(rule.target_variable);
      mappedState[target] = value;
      explicitTargets.add(target);
    }
    if (config?.preserve_unmapped !== false) {
      for (const [key, value] of Object.entries(raw)) {
        const clean = variableKey(key);
        if (
          isBusinessVariable(clean) &&
          !appliedSources.has(clean) &&
          !explicitTargets.has(clean)
        )
          mappedState[clean] = value;
      }
    }
    return mappedState;
  }

  /**
   * Aplica sanitizações e transformações nos valores
   */
  applyTransformation(
    value: unknown,
    transform?: InboundTransformType,
    rule?: InboundMappingRule,
  ): unknown {
    if (value === null || value === undefined) return value;
    const strVal = String(value).trim();

    switch (transform) {
      case 'cpf_cnpj': {
        // Remove tudo que não for dígito
        const digits = strVal.replace(/\D/g, '');
        if (digits.length === 11) {
          // Formata CPF: 000.000.000-00
          return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        } else if (digits.length === 14) {
          // Formata CNPJ: 00.000.000/0000-00
          return digits.replace(
            /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
            '$1.$2.$3/$4-$5',
          );
        }
        return digits || strVal;
      }

      case 'phone': {
        // Remove caracteres não numéricos
        const digits = strVal.replace(/\D/g, '');
        if (digits.length === 11) {
          // Celular BR: (XX) 9XXXX-XXXX
          return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        } else if (digits.length === 10) {
          // Fixo BR: (XX) XXXX-XXXX
          return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
        }
        return digits || strVal;
      }

      case 'currency': {
        let num: number;
        if (typeof value === 'number') {
          num = value;
        } else {
          let cleaned = strVal.replace(/[R$\s]/gi, '');
          // Identifica se vírgula é decimal (ex: 1.500,50 ou 250,00)
          if (
            cleaned.includes(',') &&
            (!cleaned.includes('.') ||
              cleaned.indexOf('.') < cleaned.indexOf(','))
          ) {
            cleaned = cleaned.replace(/\./g, '').replace(',', '.');
          } else if (cleaned.includes(',') && cleaned.includes('.')) {
            // Formato US com vírgula de milhar: 1,500.50
            cleaned = cleaned.replace(/,/g, '');
          }
          num = parseFloat(cleaned);
        }

        if (!isNaN(num)) {
          return num.toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        }
        return strVal;
      }

      case 'number': {
        if (typeof value === 'number') return value;
        let cleaned = strVal.replace(/[R$\s]/gi, '');
        if (
          cleaned.includes(',') &&
          (!cleaned.includes('.') ||
            cleaned.indexOf('.') < cleaned.indexOf(','))
        ) {
          cleaned = cleaned.replace(/\./g, '').replace(',', '.');
        } else if (cleaned.includes(',') && cleaned.includes('.')) {
          cleaned = cleaned.replace(/,/g, '');
        }
        const num = parseFloat(cleaned);
        return isNaN(num) ? strVal : num;
      }

      case 'boolean': {
        const lower = strVal.toLowerCase();
        if (
          ['true', '1', 'sim', 's', 'yes', 'y', 'verdadeiro'].includes(lower)
        ) {
          return true;
        }
        if (['false', '0', 'nao', 'não', 'n', 'no', 'falso'].includes(lower)) {
          return false;
        }
        return Boolean(value);
      }

      case 'uppercase':
        return strVal.toUpperCase();

      case 'lowercase':
        return strVal.toLowerCase();

      case 'date': {
        // Padroniza datas (ISO -> DD/MM/AAAA ou preserva DD/MM/AAAA)
        if (/^\d{4}-\d{2}-\d{2}/.test(strVal)) {
          const [year, month, day] = strVal.substring(0, 10).split('-');
          return `${day}/${month}/${year}`;
        }
        return strVal;
      }

      case 'last_chars': {
        const count = Math.max(1, rule?.char_count ?? 2);
        const source =
          rule?.only_digits !== false ? strVal.replace(/\D/g, '') : strVal;
        if (!source) return strVal;
        return source.length <= count ? source : source.slice(-count);
      }

      case 'first_chars': {
        const count = Math.max(1, rule?.char_count ?? 2);
        const source =
          rule?.only_digits !== false ? strVal.replace(/\D/g, '') : strVal;
        if (!source) return strVal;
        return source.slice(0, count);
      }

      case 'mask_cpf': {
        const digits = strVal.replace(/\D/g, '');
        const visibleCount = Math.max(1, rule?.char_count ?? 2);
        if (digits.length === 11) {
          const visible = digits.slice(-visibleCount);
          return `***.***.***-${visible}`;
        } else if (digits.length > visibleCount) {
          return `***${digits.slice(-visibleCount)}`;
        }
        return digits || strVal;
      }

      case 'substring': {
        const start = Math.max(0, rule?.slice_start ?? 0);
        const length = rule?.slice_length;
        const source =
          rule?.only_digits === true ? strVal.replace(/\D/g, '') : strVal;
        if (length !== undefined && length > 0) {
          return source.substring(start, start + length);
        }
        return source.substring(start);
      }

      case 'text':
      default:
        return typeof value === 'string' ? strVal : value;
    }
  }
}
