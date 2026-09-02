import { NotFoundException } from '@nestjs/common';
import { AgentsService } from './agents.service';

describe('AgentsService - Simulation & Preview', () => {
  const mockRepository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const mockMetadata = { refresh: jest.fn() };
  const mockPrisma = {
    painel_clients: { findUnique: jest.fn() },
    painel_agents: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };

  let service: AgentsService;
  const companyId = 'company-1';
  const clientId = 'client-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentsService(
      mockRepository as never,
      mockMetadata as never,
      mockPrisma as never,
    );

    mockPrisma.painel_clients.findUnique.mockResolvedValue({
      id: clientId,
      company_id: companyId,
    });
  });

  describe('previewPrompt', () => {
    it('deve resolver prompt a partir de agent_data com variáveis e condicionais', async () => {
      const res = await service.previewPrompt(
        clientId,
        {
          agent_data: {
            system_prompt:
              'Olá {{nome_cliente}}! [SE saldo > 1000]Você tem limite VIP.[SENÃO]Você tem limite padrão.[FIM SE]',
          },
          state: {
            nome_cliente: 'Mariana',
            saldo: 1500,
          },
        },
        companyId,
      );

      expect(res.resolved_prompt).toContain('Olá Mariana!');
      expect(res.resolved_prompt).toContain('Você tem limite VIP.');
      expect(res.resolved_prompt).not.toContain('Você tem limite padrão.');
      expect(res.char_count).toBeGreaterThan(0);
      expect(res.token_estimate).toBeGreaterThan(0);
    });

    it('deve buscar agente no repositório se agent_id for fornecido', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'agent-123',
        system_prompt: 'Roteiro de teste para {{empresa}}.',
      });

      const res = await service.previewPrompt(
        clientId,
        {
          agent_id: 'agent-123',
          state: {
            empresa: 'Synexa AI',
          },
        },
        companyId,
      );

      expect(res.resolved_prompt).toBe('Roteiro de teste para Synexa AI.');
    });

    it('deve lançar NotFoundException se agente não for encontrado', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(
        service.previewPrompt(
          clientId,
          { agent_id: 'agent-inexistente' },
          companyId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('simulateSequence', () => {
    it('deve simular ativação sequencial de múltiplos agentes', async () => {
      mockPrisma.painel_agents.findMany.mockResolvedValue([
        {
          id: 'agent-triagem',
          service_step: 'Triagem',
          execution_order: 1,
          is_initial: true,
          is_active: true,
          system_prompt: 'Olá, sou a Triagem.',
          activation_conditions: null,
        },
        {
          id: 'agent-cobranca',
          service_step: 'Cobrança',
          execution_order: 2,
          is_initial: false,
          is_active: true,
          system_prompt: 'Cobrança de {{valor_divida}}.',
          activation_conditions: {
            logic: 'AND',
            conditions: [
              { variable: 'status', operator: 'equals', value: 'inadimplente' },
              { variable: 'dias', operator: 'gt', value: 10 },
            ],
          },
        },
      ]);

      // 1. Cenário que ativa o agente de cobrança
      const resCobranca = await service.simulateSequence(
        clientId,
        {
          state: {
            status: 'inadimplente',
            dias: 30,
            valor_divida: 'R$ 2.000,00',
          },
        },
        companyId,
      );

      expect(resCobranca.active_agent_id).toBe('agent-cobranca');
      expect(resCobranca.evaluations).toHaveLength(2);
      expect(resCobranca.evaluations[1].matched).toBe(true);
      expect(resCobranca.evaluations[1].resolved_prompt).toContain(
        'R$ 2.000,00',
      );

      // 2. Cenário sem inadimplência -> Agente inicial Triagem
      const resTriagem = await service.simulateSequence(
        clientId,
        {
          state: {
            status: 'em_dia',
            dias: 0,
          },
        },
        companyId,
      );

      expect(resTriagem.active_agent_id).toBe('agent-triagem');
    });
  });
});
