import { CrmDataTransformerService } from './crm-data-transformer.service';

describe('CrmDataTransformerService', () => {
  let service: CrmDataTransformerService;

  beforeEach(() => {
    service = new CrmDataTransformerService();
  });

  it('deve derivar promessa = true quando agreementId estiver presente no estado da sessão', () => {
    const result = service.transform({
      sessionState: {
        agreementId: 'AGR-99881',
        valor_original: 1500,
        valor_negociado: 1200,
        motivo_atraso: 'desemprego',
      },
      endUser: {
        id: 'usr-12345',
        name: 'Carlos Silva',
        metadata: {
          document_number: '123.456.789-00',
          phone: '+5511999998888',
        },
      },
      conversation: {
        id: 'conv-99999',
        origin_channel: 'whatsapp',
        status: 'closed',
      },
    });

    expect(result.id_sessao).toBe('conv-99999');
    expect(result.id_contato).toBe('usr-12345');
    expect(result.canal).toBe('whatsapp');
    expect(result.status_conversa).toBe('closed');
    expect(result.promessa).toBe(true);
    expect(result.id_acordo).toBe('AGR-99881');
    expect(result.documento).toBe('123.456.789-00');
    expect(result.nome).toBe('Carlos Silva');
    expect(result.telefone).toBe('+5511999998888');
    expect(result.dados_variaveis).toEqual({
      valor_original: 1500,
      valor_negociado: 1200,
      motivo_atraso: 'desemprego',
    });
  });

  it('deve permitir retornar números customizados (ex: 1 e 0) para agreementId', () => {
    const result = service.transform({
      sessionState: {
        agreementId: 'AGR-100',
      },
      config: {
        derived_fields: [
          {
            target_column: 'status_acordo_num',
            type: 'number',
            operator: 'is_not_empty',
            source_field: 'agreementId',
            return_if_true: 1,
            return_if_false: 0,
          },
        ],
      },
    });

    expect(result.status_acordo_num).toBe(1);
  });

  it('deve permitir retornar strings customizadas (ex: "ACORDO_FIRMADO" ou "SEM_ACORDO")', () => {
    const resultWithAgreement = service.transform({
      sessionState: {
        agreementId: 'AGR-100',
      },
      config: {
        derived_fields: [
          {
            target_column: 'situacao',
            type: 'string',
            operator: 'is_not_empty',
            source_field: 'agreementId',
            return_if_true: 'ACORDO_FIRMADO',
            return_if_false: 'SEM_ACORDO',
          },
        ],
      },
    });

    const resultWithoutAgreement = service.transform({
      sessionState: {},
      config: {
        derived_fields: [
          {
            target_column: 'situacao',
            type: 'string',
            operator: 'is_not_empty',
            source_field: 'agreementId',
            return_if_true: 'ACORDO_FIRMADO',
            return_if_false: 'SEM_ACORDO',
          },
        ],
      },
    });

    expect(resultWithAgreement.situacao).toBe('ACORDO_FIRMADO');
    expect(resultWithoutAgreement.situacao).toBe('SEM_ACORDO');
  });

  it('deve copiar o valor direto do campo quando configurado como pass_through ou $value', () => {
    const result = service.transform({
      sessionState: {
        numero_contrato: 'CTR-8899',
      },
      config: {
        derived_fields: [
          {
            target_column: 'contrato_crm',
            type: 'string',
            operator: 'pass_through',
            source_field: 'numero_contrato',
          },
        ],
      },
    });

    expect(result.contrato_crm).toBe('CTR-8899');
  });

  it('deve aplicar regras derivadas personalizadas configuradas pelo cliente', () => {
    const result = service.transform({
      sessionState: {
        agreement_code: 'ACORDO-777',
        score_cliente: 85,
        cidade: 'São Paulo',
      },
      config: {
        derived_fields: [
          {
            target_column: 'tem_acordo_firmado',
            type: 'boolean',
            operator: 'is_not_empty',
            source_field: 'agreement_code',
            return_if_true: true,
            return_if_false: false,
          },
          {
            target_column: 'cliente_vip',
            type: 'boolean',
            operator: '>=',
            source_field: 'score_cliente',
            compare_value: 80,
            return_if_true: true,
            return_if_false: false,
          },
        ],
        include_unmapped_as_json: true,
      },
    });

    expect(result.tem_acordo_firmado).toBe(true);
    expect(result.cliente_vip).toBe(true);
    expect(result.dados_variaveis).toEqual({
      cidade: 'São Paulo',
    });
  });

  it('deve retornar fallback quando a regra derivada não for satisfeita', () => {
    const result = service.transform({
      sessionState: {
        score_cliente: 40,
      },
      config: {
        derived_fields: [
          {
            target_column: 'cliente_vip',
            type: 'boolean',
            operator: '>=',
            source_field: 'score_cliente',
            compare_value: 80,
            return_if_true: true,
            return_if_false: false,
          },
        ],
      },
    });

    expect(result.cliente_vip).toBe(false);
  });
});
