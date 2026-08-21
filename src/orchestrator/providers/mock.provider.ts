import { Logger } from '@nestjs/common';
import type {
  LLMProvider,
  ChatParams,
  AgentChatParams,
  ProviderCapabilities,
} from './llm-provider.interface';
import type { AgentOutput } from '../types/agent-message.types';

export class MockLlmProvider implements LLMProvider {
  private readonly logger = new Logger(MockLlmProvider.name);
  private readonly latencyMs: number;

  constructor(latencyMs?: number) {
    this.latencyMs = latencyMs ?? Number(process.env.MOCK_LLM_LATENCY_MS || 80);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  async chat(params: ChatParams): Promise<{
    text: string;
    action: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }> {
    this.logger.log(
      `🤖 [MockLlmProvider] Processando mensagem mock: "${params.userMessage.substring(0, 50)}..."`,
    );
    await this.sleep(this.latencyMs);

    const userText = params.userMessage.toLowerCase();

    // Simulação de regras de transição simples se presentes no prompt
    if (
      userText.includes('suporte') ||
      userText.includes('problema') ||
      userText.includes('defeito')
    ) {
      if (params.systemPrompt.includes('TRANSFERIR:suporte_tecnico')) {
        return {
          text: 'TRANSFERIR:suporte_tecnico',
          action: 'speak',
          usage: { input_tokens: 45, output_tokens: 8, total_tokens: 53 },
        };
      }
    }

    if (
      userText.includes('vendas') ||
      userText.includes('preço') ||
      userText.includes('comprar')
    ) {
      if (params.systemPrompt.includes('TRANSFERIR:vendas')) {
        return {
          text: 'TRANSFERIR:vendas',
          action: 'speak',
          usage: { input_tokens: 42, output_tokens: 6, total_tokens: 48 },
        };
      }
    }

    const mockResponse =
      `[Mock LLM Response] Olá! Esta é uma resposta sintética do provedor Mock local do Synexa. ` +
      `Recebi sua mensagem: "${params.userMessage}". Como posso ajudar com mais informações?`;

    return {
      text: mockResponse,
      action: 'speak',
      usage: {
        input_tokens: 60,
        output_tokens: 35,
        total_tokens: 95,
      },
    };
  }

  async chatWithParts(params: AgentChatParams): Promise<AgentOutput> {
    this.logger.log(
      `🤖 [MockLlmProvider] Processando chatWithParts para agente`,
    );
    await this.sleep(this.latencyMs);

    const inputText =
      params.input.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(' ') || 'Mensagem multimodal mock';

    const responseText =
      `[Mock Agent Output] Resposta processada com sucesso no ambiente local (Mock Mode). ` +
      `Contexto RAG: ${params.ragContext ? 'Sim' : 'Não'}.`;

    return {
      text: responseText,
      parts: [{ type: 'text', text: responseText, order_index: 0 }],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        total_tokens: 160,
      },
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      text: true,
      vision: true,
      audio: true,
      tools: true,
    };
  }
}
