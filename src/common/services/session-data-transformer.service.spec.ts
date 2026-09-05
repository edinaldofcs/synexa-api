import { SessionDataTransformerService } from './session-data-transformer.service';

describe('SessionDataTransformerService', () => {
  let service: SessionDataTransformerService;

  beforeEach(() => {
    service = new SessionDataTransformerService();
  });

  it('deve extrair campos padrões e derivar promessa e id_acordo quando agreementId estiver presente', () => {
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
      config: {
        operation_type: 'cobranca',
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

  it('deve permitir retornar números customizados (ex: 1 e 0) para regras de negócio', () => {
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
            target_column: 'contrato_externo',
            type: 'string',
            operator: 'pass_through',
            source_field: 'numero_contrato',
          },
        ],
      },
    });

    expect(result.contrato_externo).toBe('CTR-8899');
  });

  it('deve aplicar regras derivadas personalizadas para qualquer operação', () => {
    const result = service.transform({
      sessionState: {
        ticket_id: 'TCK-5544',
        criticidade: 'alta',
        sistema: 'financeiro',
      },
      config: {
        operation_type: 'suporte',
        derived_fields: [
          {
            target_column: 'ticket_aberto',
            type: 'boolean',
            operator: 'is_not_empty',
            source_field: 'ticket_id',
            return_if_true: true,
            return_if_false: false,
          },
          {
            target_column: 'urgente',
            type: 'boolean',
            operator: '==',
            source_field: 'criticidade',
            compare_value: 'alta',
            return_if_true: true,
            return_if_false: false,
          },
        ],
        include_unmapped_as_json: true,
      },
    });

    expect(result.ticket_aberto).toBe(true);
    expect(result.urgente).toBe(true);
    expect(result.dados_variaveis).toEqual({
      sistema: 'financeiro',
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
