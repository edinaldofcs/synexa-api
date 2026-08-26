import net from 'net';
import { AsteriskFastAgiAdapter } from './asterisk/asterisk-fastagi.adapter';
import { CallFlexAdapter } from './callflex/callflex.adapter';
import { buildAgentPromptFromBlocks } from '../../agents/utils/agent-prompt-builder.util';

describe('Telephony Adapters & Variable Injection', () => {
  describe('AsteriskFastAgiAdapter', () => {
    it('deve extrair variaveis padrao e variaveis customizadas da URA / dialplan', () => {
      const mockSocket = new net.Socket();
      const rawAgiEnv = {
        agi_channel: 'PJSIP/6001-00000001',
        agi_uniqueid: '1724360000.1',
        agi_callerid: '11999887766',
        agi_calleridname: 'Carlos Silva',
        agi_extension: '5000',
        agi_dnid: '0800123456',
        agi_variable_CPF_CLIENTE: '12345678900',
        SYNEXA_SALDO: '250.50',
        SYNEXA_PROTOCOLO: '20260822001',
      };

      const adapter = new AsteriskFastAgiAdapter(mockSocket, rawAgiEnv);

      expect(adapter.id).toBe('1724360000.1');
      expect(adapter.metadata.callerNumber).toBe('11999887766');
      expect(adapter.metadata.callerName).toBe('Carlos Silva');
      expect(adapter.metadata.customVariables?.CPF_CLIENTE).toBe('12345678900');
      expect(adapter.metadata.customVariables?.SYNEXA_SALDO).toBe('250.50');
      expect(adapter.metadata.customVariables?.SYNEXA_PROTOCOLO).toBe(
        '20260822001',
      );
    });

    it('deve fazer parse de JSON complexo enviado no dialplan do Asterisk', () => {
      const mockSocket = new net.Socket();
      const rawAgiEnv = {
        agi_channel: 'PJSIP/6001-00000002',
        agi_arg_3: JSON.stringify({
          cliente_nome: 'Mariana Lima',
          plano: 'Premium VIP',
          faturas_abertas: 2,
        }),
      };

      const adapter = new AsteriskFastAgiAdapter(mockSocket, rawAgiEnv);
      expect(adapter.metadata.customVariables?.cliente_nome).toBe(
        'Mariana Lima',
      );
      expect(adapter.metadata.customVariables?.plano).toBe('Premium VIP');
      expect(adapter.metadata.customVariables?.faturas_abertas).toBe(2);
    });

    it('deve interpolar variaveis da telefonia no prompt do agente', () => {
      const agent = {
        system_prompt:
          'Olá {{cliente_nome}}, seu saldo é R$ {{SYNEXA_SALDO}} e seu CPF é {{CPF_CLIENTE}}.',
      };

      const contextVariables = {
        cliente_nome: 'Carlos Silva',
        CPF_CLIENTE: '12345678900',
        SYNEXA_SALDO: '250.50',
      };

      const prompt = buildAgentPromptFromBlocks(agent, contextVariables);

      expect(prompt).toBe(
        'Olá Carlos Silva, seu saldo é R$ 250.50 e seu CPF é 12345678900.',
      );
    });

    it('deve enviar comando SET VARIABLE para o Asterisk quando setVariable for chamado', () => {
      const mockSocket = new net.Socket();
      const writeSpy = jest
        .spyOn(mockSocket, 'write')
        .mockImplementation(() => true);

      const adapter = new AsteriskFastAgiAdapter(mockSocket, {});
      adapter.setVariable('SYNEXA_STATUS', 'RESOLVIDO');

      expect(writeSpy).toHaveBeenCalledWith(
        'SET VARIABLE SYNEXA_STATUS "RESOLVIDO"\n',
      );
      expect(adapter.getVariable('SYNEXA_STATUS')).toBe('RESOLVIDO');
    });
  });

  describe('CallFlexAdapter', () => {
    it('deve inicializar com metadados e manipular variaveis customizadas', () => {
      const adapter = new CallFlexAdapter({
        metadata: {
          callerNumber: '11988776655',
          customVariables: {
            lead_id: 'lead_9988',
            campanha: 'Reativação',
          },
        },
      });

      expect(adapter.providerName).toBe('callflex');
      expect(adapter.metadata.callerNumber).toBe('11988776655');
      expect(adapter.getVariable('lead_id')).toBe('lead_9988');

      adapter.setVariable('status_lead', 'contatado');
      expect(adapter.getVariable('status_lead')).toBe('contatado');
    });
  });
});
