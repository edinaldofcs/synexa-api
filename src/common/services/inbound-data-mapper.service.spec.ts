import {
  InboundDataMapperService,
  InboundMappingConfig,
} from './inbound-data-mapper.service';

describe('InboundDataMapperService', () => {
  let service: InboundDataMapperService;

  beforeEach(() => {
    service = new InboundDataMapperService();
  });

  it('maps external dialer variables to standard session variables (var_1 -> cnpj_cpf)', () => {
    const rawData = {
      var_1: '12345678909',
      var_2: 'Carlos Eduardo',
      var_3: '1500,50',
      caller_number: '11987654321',
      extra_unmapped: 'info_adicional',
    };

    const config: InboundMappingConfig = {
      enabled: true,
      rules: [
        {
          source_channel: 'voice',
          source_field: 'var_1',
          target_variable: 'cnpj_cpf',
          transform: 'cpf_cnpj',
        },
        {
          source_channel: 'voice',
          source_field: 'var_2',
          target_variable: 'nome_cliente',
          transform: 'text',
        },
        {
          source_channel: 'voice',
          source_field: 'var_3',
          target_variable: 'saldo_devedor',
          transform: 'currency',
        },
        {
          source_channel: 'all',
          source_field: 'caller_number',
          target_variable: 'telefone',
          transform: 'phone',
        },
      ],
    };

    const result = service.mapInboundData(rawData, config, 'voice');

    expect(result.cnpj_cpf).toBe('123.456.789-09');
    expect(result.nome_cliente).toBe('Carlos Eduardo');
    expect(result.saldo_devedor).toBe('1.500,50');
    expect(result.telefone).toBe('(11) 98765-4321');
    expect(result.extra_unmapped).toBe('info_adicional');
  });

  it('maps CRM / Webhook payload correctly', () => {
    const rawData = {
      customer_tax_id: '12345678000195',
      customer_name: 'Empresa XPTO Ltda',
      due_date: '2026-09-15',
    };

    const config: InboundMappingConfig = {
      enabled: true,
      rules: [
        {
          source_channel: 'crm',
          source_field: 'customer_tax_id',
          target_variable: 'cnpj_cpf',
          transform: 'cpf_cnpj',
        },
        {
          source_channel: 'crm',
          source_field: 'customer_name',
          target_variable: 'razao_social',
          transform: 'uppercase',
        },
        {
          source_channel: 'crm',
          source_field: 'due_date',
          target_variable: 'data_vencimento',
          transform: 'date',
        },
      ],
    };

    const result = service.mapInboundData(rawData, config, 'crm');

    expect(result.cnpj_cpf).toBe('12.345.678/0001-95');
    expect(result.razao_social).toBe('EMPRESA XPTO LTDA');
    expect(result.data_vencimento).toBe('15/09/2026');
  });

  it('handles dot notation for nested API responses (e.g. dados.cliente.cpf)', () => {
    const rawData = {
      status: 'ok',
      dados: {
        cliente: {
          cpf: '11122233344',
          saldo: '250.00',
        },
      },
    };

    const config: InboundMappingConfig = {
      enabled: true,
      rules: [
        {
          source_field: 'dados.cliente.cpf',
          target_variable: 'cpf',
          transform: 'cpf_cnpj',
        },
        {
          source_field: 'dados.cliente.saldo',
          target_variable: 'saldo_devedor',
          transform: 'currency',
        },
      ],
    };

    const result = service.mapInboundData(rawData, config, 'api');

    expect(result.cpf).toBe('111.222.333-44');
    expect(result.saldo_devedor).toBe('250,00');
  });

  it('applies fallback default_value when source field is missing or empty', () => {
    const rawData = {
      var_1: '',
    };

    const config: InboundMappingConfig = {
      enabled: true,
      rules: [
        {
          source_field: 'var_1',
          target_variable: 'tipo_atendimento',
          default_value: 'Geral',
        },
        {
          source_field: 'campo_inexistente',
          target_variable: 'prioridade',
          default_value: 'Normal',
        },
      ],
    };

    const result = service.mapInboundData(rawData, config, 'all');

    expect(result.tipo_atendimento).toBe('Geral');
    expect(result.prioridade).toBe('Normal');
  });

  it('respects channel filters and ignores non-matching channels', () => {
    const rawData = {
      var_1: '123',
    };

    const config: InboundMappingConfig = {
      enabled: true,
      rules: [
        {
          source_channel: 'voice',
          source_field: 'var_1',
          target_variable: 'voice_only_var',
        },
        {
          source_channel: 'whatsapp',
          source_field: 'var_1',
          target_variable: 'whatsapp_only_var',
        },
      ],
    };

    const voiceResult = service.mapInboundData(rawData, config, 'voice');
    expect(voiceResult.voice_only_var).toBe('123');
    expect(voiceResult.whatsapp_only_var).toBeUndefined();

    const whatsappResult = service.mapInboundData(rawData, config, 'whatsapp');
    expect(whatsappResult.whatsapp_only_var).toBe('123');
    expect(whatsappResult.voice_only_var).toBeUndefined();
  });
});
