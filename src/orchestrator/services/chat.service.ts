import { Injectable, Logger } from '@nestjs/common';
import { OrchestratorToolService } from './tool.service';
import { OrchestratorToolExecutorService } from './tool-executor.service';
import { OrchestratorSessionService } from './session.service';
import { getLLMProvider } from '../providers/llm-provider.factory';

@Injectable()
export class OrchestratorChatService {
  private readonly logger = new Logger(OrchestratorChatService.name);

  constructor(
    private readonly toolService: OrchestratorToolService,
    private readonly toolExecutorService: OrchestratorToolExecutorService,
    private readonly sessionService: OrchestratorSessionService,
  ) {}

  async sendToAgent(
    systemPrompt: string,
    userMessage: string,
    history: { role: string; content: string }[] = [],
    client_phone: string,
    company_phone: string,
    client_id: string,
    persona_id: string,
  ): Promise<{ text: string; action: string }> {
    const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES || '2', 10);
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const allToolsList = await this.toolService.getActiveTools(client_id, persona_id);
        const publicTools = allToolsList.filter(t => t.visible_to_agent === true);

        const llmProvider = getLLMProvider();

        const finalText = await llmProvider.chat({
          systemPrompt,
          userMessage,
          history,
          publicTools,
          allToolsList,
          executeExternalApiCallback: async ({ functionName, args, toolsList }) => {
            const result = await this.toolExecutorService.executeExternalApi({
              functionName,
              args,
              toolsList,
              client_phone,
              company_phone,
            });

            if (result && !result.error) {
              await this.sessionService.updateSession(client_phone, company_phone, result);
            }

            return result;
          },
        });

        this.logger.log({ finalText }, 'Mensagem final gerada pelo LLM');
        return finalText;
      } catch (error: any) {
        lastError = error;
        this.logger.warn({ error: error.message, attempt }, `Falha na tentativa ${attempt}. Fazendo recall...`);

        if (attempt <= MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    this.logger.error({ error: lastError?.message }, 'Todas as tentativas de recall falharam.');
    return {
      text: process.env.CHAT_ERROR_MESSAGE || 'Desculpe, tive um problema técnico ao processar sua solicitação. Poderia repetir?',
      action: 'speak',
    };
  }
}
