import { Test, TestingModule } from '@nestjs/testing';
import { ToolsController } from './tools.controller';
import { NativeToolsService } from '../services/native-tools.service';

describe('ToolsController', () => {
  let controller: ToolsController;
  let nativeToolsService: NativeToolsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ToolsController],
      providers: [NativeToolsService],
    }).compile();

    controller = module.get<ToolsController>(ToolsController);
    nativeToolsService = module.get<NativeToolsService>(NativeToolsService);
  });

  it('deve validar parte de variável via endpoint HTTP', () => {
    const result = controller.validateVariable({
      variable_name: 'cnpj_cpf',
      match_type: 'left',
      value_to_check: '123',
      session_data: { cnpj_cpf: '123.456.789-00' },
    });

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.matches).toBe(true);
  });

  it('deve gravar variável na sessão via endpoint HTTP', () => {
    const sessionData: Record<string, unknown> = {};
    const result = controller.setSessionVariable({
      name: 'forma_pagamento',
      value: 'PIX',
      session_data: sessionData,
    });

    expect(result.ok).toBe(true);
    expect(sessionData.forma_pagamento).toBe('PIX');
  });

  it('deve calcular desconto e parcelas via endpoint HTTP', () => {
    const result = controller.calculateFinancial({
      operation: 'both',
      principal_amount: 1000,
      discount_percentage: 10,
      installments_count: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.final_cash_amount).toBe(900);
    expect(result.installment_value).toBe(300);
  });
});
