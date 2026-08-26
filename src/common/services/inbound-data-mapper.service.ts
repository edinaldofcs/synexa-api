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
  | 'boolean';

export type InboundChannelSource =
  | 'all'
  | 'voice'
  | 'crm'
  | 'webhook'
  | 'api'
  | 'whatsapp'
  | 'webchat';

export interface InboundMappingRule {
  id?: string;
  source_channel?: InboundChannelSource;
  source_field: string;
  target_variable: string;
  transform?: InboundTransformType;
  default_value?: string;
  description?: string;
}

export interface InboundMappingConfig {
  enabled?: boolean;
  preserve_unmapped?: boolean;
  rules?: InboundMappingRule[];
}

@Injectable()
export class InboundDataMapperService {
  private readonly logger = new Logger(InboundDataMapperService.name);

  /**
   * Mapeia dados brutos de entrada (Discador, CRM, API, Webhook)
   * para variáveis padronizadas da sessão com base nas regras do cliente.
   */
  mapInboundData(
    rawData: Record<string, unknown> | null | undefined,
    config: InboundMappingConfig | null | undefined,
    channel?: string,
  ): Record<string, unknown> {
    if (!rawData || typeof rawData !== 'object') {
      return {};
    }

    const mappedState: Record<string, unknown> = {};
    const rules = config?.rules || [];
    const isEnabled = config?.enabled !== false;
    const preserveUnmapped = config?.preserve_unmapped !== false;

    // Normaliza canal
    const normalizedChannel = (channel || 'all').toLowerCase();

    // Se as regras estiverem desabilitadas, retorna os dados brutos
    if (!isEnabled || rules.length === 0) {
      return { ...rawData };
    }

    const appliedSourceKeys = new Set<string>();

    for (const rule of rules) {
      if (!rule.source_field || !rule.target_variable) continue;

      // Verifica compatibilidade de canal
      const ruleChannel = (rule.source_channel || 'all').toLowerCase();
      const channelMatches =
        ruleChannel === 'all' ||
        ruleChannel === normalizedChannel ||
        (ruleChannel === 'voice' &&
          [
            'voice',
            'telephony',
            'fastagi',
            'callflex',
            'asterisk',
            'sip',
          ].includes(normalizedChannel)) ||
        (ruleChannel === 'crm' &&
          ['crm', 'webhook', 'api'].includes(normalizedChannel)) ||
        (ruleChannel === 'api' &&
          ['api', 'webhook'].includes(normalizedChannel));

      if (!channelMatches) continue;

      // Busca o valor na entrada bruta (case-insensitive e busca direta)
      const rawValue = this.extractValue(rawData, rule.source_field);
      appliedSourceKeys.add(rule.source_field.toLowerCase());

      let finalValue: unknown = rawValue;

      // Se o valor for nulo/indefinido/string vazia, aplica default_value se existir
      if (
        (finalValue === undefined ||
          finalValue === null ||
          (typeof finalValue === 'string' && finalValue.trim() === '')) &&
        rule.default_value !== undefined &&
        rule.default_value !== ''
      ) {
        finalValue = rule.default_value;
      }

      // Aplica transformações de tipo e sanitização
      if (
        finalValue !== undefined &&
        finalValue !== null &&
        finalValue !== ''
      ) {
        finalValue = this.applyTransformation(finalValue, rule.transform);
        mappedState[rule.target_variable] = finalValue;
      }
    }

    // Preserva campos não mapeados se configurado
    if (preserveUnmapped) {
      for (const [key, value] of Object.entries(rawData)) {
        if (
          !appliedSourceKeys.has(key.toLowerCase()) &&
          !Object.prototype.hasOwnProperty.call(mappedState, key)
        ) {
          mappedState[key] = value;
        }
      }
    }

    return mappedState;
  }

  /**
   * Extrai valor do payload bruto com suporte a case-insensitive e paths com ponto (ex: dados.cpf)
   */
  private extractValue(
    obj: Record<string, unknown>,
    keyOrPath: string,
  ): unknown {
    if (Object.prototype.hasOwnProperty.call(obj, keyOrPath)) {
      return obj[keyOrPath];
    }

    // Busca por caminho pontilhado (dot notation)
    if (keyOrPath.includes('.')) {
      const parts = keyOrPath.split('.');
      let current: any = obj;
      for (const part of parts) {
        if (
          current === null ||
          current === undefined ||
          typeof current !== 'object'
        ) {
          current = undefined;
          break;
        }
        current = current[part];
      }
      if (current !== undefined) return current;
    }

    // Busca case-insensitive no primeiro nível
    const lowerKey = keyOrPath.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === lowerKey) {
        return v;
      }
    }

    return undefined;
  }

  /**
   * Aplica sanitizações e transformações nos valores
   */
  applyTransformation(
    value: unknown,
    transform?: InboundTransformType,
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

      case 'text':
      default:
        return typeof value === 'string' ? strVal : value;
    }
  }
}
