import { Injectable, Logger } from '@nestjs/common';

export interface NativeToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

@Injectable()
export class NativeToolsService {
  private readonly logger = new Logger(NativeToolsService.name);

  /**
   * Retorna as declara????es de ferramentas nativas no formato de function calling (Gemini / OpenAI).
   */
  getDeclarations(): NativeToolDeclaration[] {
    return [
      {
        name: 'validate_variable_part',
        description:
          'Valida com seguran??a se uma parte/trecho informado pelo usu??rio confere com uma vari??vel da sess??o ' +
          '(ex: conferir os 3 primeiros d??gitos do CPF, 4 ??ltimos d??gitos do cart??o ou telefone, sem precisar carregar o documento completo no di??logo).',
        parameters: {
          type: 'object',
          properties: {
            variable_name: {
              type: 'string',
              description:
                'Nome da vari??vel armazenada na sess??o a ser conferida (ex: cnpj_cpf, telefone, data_nascimento, email)',
            },
            match_type: {
              type: 'string',
              enum: ['left', 'right', 'contains', 'exact'],
              description:
                'Tipo de valida????o: "left" (in??cio / primeiros d??gitos), "right" (final / ??ltimos d??gitos), "contains" (cont??m em qualquer parte) ou "exact" (exatamente igual)',
            },
            value_to_check: {
              type: 'string',
              description:
                'O valor ou trecho informado pelo usu??rio para ser verificado',
            },
            length: {
              type: 'number',
              description:
                'Quantidade opcional de caracteres a considerar (ex: 3 para os 3 primeiros d??gitos)',
            },
          },
          required: ['variable_name', 'match_type', 'value_to_check'],
        },
      },
      {
        name: 'set_session_variable',
        description:
          'Cria ou atualiza uma vari??vel no estado da sess??o do atendimento em tempo real. ' +
          'Use sempre que o cliente informar ou confirmar um dado relevante (ex: forma_pagamento, valor_acordo, data_vencimento, motivo_recusa, email) ' +
          'para que fique dispon??vel para os pr??ximos agentes, integra????es e relat??rios.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'Nome/chave da vari??vel (ex: forma_pagamento, valor_acordo, data_vencimento, motivo_recusa, email)',
            },
            value: {
              type: 'string',
              description: 'Valor a ser gravado na sess??o',
            },
          },
          required: ['name', 'value'],
        },
      },
      {
        name: 'calculate_financial',
        description:
          'Executa c??lculos matem??ticos financeiros r??gidos de desconto, juros e parcelamento para evitar alucina????es. ' +
          'Suporta c??lculo de desconto percentual ou fixo, divis??o de parcelas sem juros ou parcelamento com juros compostos.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['discount', 'installment', 'both'],
              description:
                'Tipo de opera????o: "discount" (apenas desconto), "installment" (apenas parcelas) ou "both" (aplica desconto e parcela o saldo)',
            },
            principal_amount: {
              type: 'number',
              description:
                'Valor principal / total da d??vida ou compra (ex: 1200.50)',
            },
            discount_percentage: {
              type: 'number',
              description:
                'Percentual de desconto ?  vista ou promocional (ex: 15 para 15%)',
            },
            discount_fixed_amount: {
              type: 'number',
              description: 'Valor de desconto em reais (ex: 150.00)',
            },
            installments_count: {
              type: 'number',
              description:
                'Quantidade de parcelas desejadas (ex: 3, 6, 10, 12)',
            },
            interest_rate_monthly: {
              type: 'number',
              description:
                'Taxa de juros mensal opcional em % (ex: 1.99 para 1.99% ao m??s). 0 ou omitido = sem juros',
            },
          },
          required: ['operation', 'principal_amount'],
        },
      },
    ];
  }

  /**
   * Executa a ferramenta nativa solicitada.
   */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionState: Record<string, unknown> = {},
  ): { ok: boolean; [key: string]: unknown } {
    switch (toolName) {
      case 'validate_variable_part':
      case 'validate_variable':
        return this.validateVariablePart(args, sessionState);

      case 'set_session_variable':
      case 'set_call_variable':
      case 'set_variable':
        return this.setSessionVariable(args, sessionState);

      case 'calculate_financial':
      case 'calculate_discount_installment':
        return this.calculateFinancial(args);

      default:
        return {
          ok: false,
          error: `Ferramenta nativa n??o suportada: ${toolName}`,
        };
    }
  }

  /**
   * Valida com seguran??a se uma parte da vari??vel fornecida pelo cliente confere com o valor da sess??o.
   */
  validateVariablePart(
    args: Record<string, unknown>,
    sessionState: Record<string, unknown>,
  ): { ok: boolean; [key: string]: unknown } {
    const rawVarName = String(args.variable_name || args.name || '').trim();
    const matchType = String(
      args.match_type || args.type || 'left',
    ).toLowerCase();
    const valueToCheck = String(args.value_to_check ?? args.value ?? '').trim();
    const length = args.length ? Number(args.length) : undefined;

    if (!rawVarName) {
      return {
        ok: false,
        error: 'O par??metro "variable_name" ?? obrigat??rio.',
      };
    }
    if (!valueToCheck) {
      return {
        ok: false,
        error: 'O par??metro "value_to_check" ?? obrigat??rio.',
      };
    }

    const storedValue = this.lookupVariableInState(sessionState, rawVarName);

    if (
      storedValue === undefined ||
      storedValue === null ||
      storedValue === ''
    ) {
      return {
        ok: false,
        valid: false,
        matches: false,
        error: `A vari??vel "${rawVarName}" n??o foi encontrada no contexto da sess??o.`,
      };
    }

    const storedStr = String(storedValue).trim();

    // Se ambos forem n??meros ou documentos (CPF/telefone), normaliza removendo caracteres especiais
    const isDocOrDigits = /^\d+$/.test(valueToCheck.replace(/[.\-/\s]/g, ''));
    let cleanStored = storedStr;
    let cleanInput = valueToCheck;

    if (isDocOrDigits) {
      cleanStored = storedStr.replace(/\D/g, '');
      cleanInput = valueToCheck.replace(/\D/g, '');
    } else {
      cleanStored = cleanStored.toLowerCase();
      cleanInput = cleanInput.toLowerCase();
    }

    let matches = false;

    switch (matchType) {
      case 'left':
      case 'starts_with':
      case 'start':
      case 'primeiros': {
        const len = length || cleanInput.length;
        const sub = cleanStored.slice(0, len);
        matches = sub === cleanInput.slice(0, len);
        break;
      }
      case 'right':
      case 'ends_with':
      case 'end':
      case 'ultimos': {
        const len = length || cleanInput.length;
        const sub = cleanStored.slice(-len);
        matches = sub === cleanInput.slice(-len);
        break;
      }
      case 'contains':
      case 'includes':
      case 'contem': {
        matches = cleanStored.includes(cleanInput);
        break;
      }
      case 'exact':
      case 'equals':
      case 'igual':
      default: {
        matches = cleanStored === cleanInput;
        break;
      }
    }

    return {
      ok: true,
      valid: matches,
      matches,
      match_type: matchType,
      message: matches
        ? 'Valida????o conclu??da com sucesso. Os dados conferem.'
        : 'Valida????o incorreta. Os dados informados n??o conferem com o registro.',
    };
  }

  /**
   * Grava uma vari??vel no estado da sess??o.
   */
  setSessionVariable(
    args: Record<string, unknown>,
    sessionState: Record<string, unknown>,
  ): { ok: boolean; [key: string]: unknown } {
    const rawKey = String(args.name || args.key || '').trim();
    const rawValue = args.value;

    if (!rawKey) {
      return {
        ok: false,
        error: 'O par??metro "name" ou "key" ?? obrigat??rio.',
      };
    }
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return { ok: false, error: 'O par??metro "value" ?? obrigat??rio.' };
    }

    const cleanKey = rawKey
      .replace(/[[\]{}]/g, '')
      .trim()
      .toLowerCase();

    sessionState[cleanKey] = rawValue;
    sessionState[rawKey] = rawValue;

    // Aliases sem??nticos autom??ticos
    if (cleanKey === 'cpf' || cleanKey === 'cnpj_cpf') {
      sessionState.cnpj_cpf = rawValue;
      sessionState.cpf = rawValue;
      sessionState.documento = rawValue;
    } else if (
      cleanKey === 'cliente_nome' ||
      cleanKey === 'nome_cliente' ||
      cleanKey === 'nome'
    ) {
      sessionState.cliente_nome = rawValue;
      sessionState.nome_cliente = rawValue;
      sessionState.nome = rawValue;
    }

    return {
      ok: true,
      saved: { [cleanKey]: rawValue },
      message: `Vari??vel "${cleanKey}" salva com sucesso no estado da sess??o.`,
    };
  }

  /**
   * Realiza c??lculos financeiros rigorosos (desconto, juros, parcelas).
   */
  calculateFinancial(args: Record<string, unknown>): {
    ok: boolean;
    [key: string]: unknown;
  } {
    const operation = String(args.operation || 'both').toLowerCase();
    const principalRaw = args.principal_amount ?? args.amount ?? args.valor;

    if (
      principalRaw === undefined ||
      principalRaw === null ||
      principalRaw === ''
    ) {
      return {
        ok: false,
        error: 'O par??metro "principal_amount" ?? obrigat??rio.',
      };
    }

    const principal = this.parseNumeric(principalRaw);
    if (isNaN(principal) || principal <= 0) {
      return {
        ok: false,
        error: 'O valor principal deve ser um n??mero positivo.',
      };
    }

    let discountApplied = 0;
    let discountPct = 0;

    if (
      args.discount_percentage !== undefined &&
      args.discount_percentage !== null
    ) {
      discountPct = Number(args.discount_percentage);
      discountApplied = Number(((principal * discountPct) / 100).toFixed(2));
    } else if (
      args.discount_fixed_amount !== undefined &&
      args.discount_fixed_amount !== null
    ) {
      discountApplied = Number(
        this.parseNumeric(args.discount_fixed_amount).toFixed(2),
      );
      discountPct = Number(((discountApplied / principal) * 100).toFixed(2));
    }

    const discountedTotal = Math.max(
      0,
      Number((principal - discountApplied).toFixed(2)),
    );
    const baseForInstallments =
      operation === 'discount' ? principal : discountedTotal;

    const installmentsCount = Number(args.installments_count || 1);
    const interestMonthly = Number(args.interest_rate_monthly || 0);

    let installmentValue = baseForInstallments;
    let totalWithInstallments = baseForInstallments;
    let totalInterest = 0;

    if (installmentsCount > 1) {
      if (interestMonthly > 0) {
        // Tabela Price: PMT = P * (i * (1+i)^n) / ((1+i)^n - 1)
        const i = interestMonthly / 100;
        const n = installmentsCount;
        const pmt =
          (baseForInstallments * (i * Math.pow(1 + i, n))) /
          (Math.pow(1 + i, n) - 1);
        installmentValue = Number(pmt.toFixed(2));
        totalWithInstallments = Number((installmentValue * n).toFixed(2));
        totalInterest = Number(
          (totalWithInstallments - baseForInstallments).toFixed(2),
        );
      } else {
        installmentValue = Number(
          (baseForInstallments / installmentsCount).toFixed(2),
        );
        totalWithInstallments = Number(
          (installmentValue * installmentsCount).toFixed(2),
        );
      }
    }

    const formatBrl = (v: number) =>
      `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let summaryText = '';
    if (discountApplied > 0 && installmentsCount > 1) {
      summaryText = `Valor original: ${formatBrl(principal)}, com desconto de ${formatBrl(discountApplied)} (${discountPct}%), fica ${formatBrl(discountedTotal)} ?  vista ou em ${installmentsCount}x de ${formatBrl(installmentValue)}${interestMonthly > 0 ? ` com juros (Total: ${formatBrl(totalWithInstallments)})` : ' sem juros'}.`;
    } else if (discountApplied > 0) {
      summaryText = `Valor original: ${formatBrl(principal)}, com desconto de ${formatBrl(discountApplied)} (${discountPct}%), total a pagar: ${formatBrl(discountedTotal)}.`;
    } else if (installmentsCount > 1) {
      summaryText = `Valor total: ${formatBrl(principal)}, parcelado em ${installmentsCount}x de ${formatBrl(installmentValue)}${interestMonthly > 0 ? ` (Total com juros: ${formatBrl(totalWithInstallments)})` : ' sem juros'}.`;
    } else {
      summaryText = `Valor total: ${formatBrl(principal)}.`;
    }

    return {
      ok: true,
      original_amount: principal,
      original_amount_formatted: formatBrl(principal),
      discount_applied: discountApplied,
      discount_applied_formatted: formatBrl(discountApplied),
      discount_percentage: discountPct,
      final_cash_amount: discountedTotal,
      final_cash_amount_formatted: formatBrl(discountedTotal),
      installments_count: installmentsCount,
      installment_value: installmentValue,
      installment_value_formatted: formatBrl(installmentValue),
      total_with_installments: totalWithInstallments,
      total_with_installments_formatted: formatBrl(totalWithInstallments),
      interest_rate_monthly: interestMonthly,
      total_interest: totalInterest,
      total_interest_formatted: formatBrl(totalInterest),
      summary_text: summaryText,
    };
  }

  /**
   * Localiza vari??vel no estado com suporte a case-insensitive e aliases sem??nticos.
   */
  private lookupVariableInState(
    state: Record<string, unknown>,
    key: string,
  ): unknown {
    if (!state || typeof state !== 'object') return undefined;

    const cleanKey = key.replace(/[[\]{}]/g, '').trim();

    if (state[key] !== undefined) return state[key];
    if (state[cleanKey] !== undefined) return state[cleanKey];

    const lowerClean = cleanKey.toLowerCase();
    for (const [k, v] of Object.entries(state)) {
      if (k.toLowerCase() === lowerClean) {
        return v;
      }
    }

    // Aliases sem??nticos
    const docKeys = ['cpf', 'cnpj_cpf', 'documento', 'cnpj', 'x-cpf', 'xcpf'];
    if (docKeys.includes(lowerClean)) {
      for (const alias of docKeys) {
        for (const [k, v] of Object.entries(state)) {
          if (k.toLowerCase() === alias && v !== undefined && v !== null) {
            return v;
          }
        }
      }
    }

    const phoneKeys = [
      'telefone',
      'phone',
      'caller_number',
      'celular',
      'whatsapp',
    ];
    if (phoneKeys.includes(lowerClean)) {
      for (const alias of phoneKeys) {
        for (const [k, v] of Object.entries(state)) {
          if (k.toLowerCase() === alias && v !== undefined && v !== null) {
            return v;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Converte strings num??ricas ou monet??rias (ex: "1.500,50") para n??mero float.
   */
  private parseNumeric(val: unknown): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const clean = val.replace(/[R$\s]/g, '');
      if (clean.includes(',') && clean.includes('.')) {
        return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
      }
      if (clean.includes(',')) {
        return parseFloat(clean.replace(',', '.'));
      }
      return parseFloat(clean);
    }
    return NaN;
  }
}
