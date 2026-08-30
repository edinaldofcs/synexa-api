import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConversationsService } from '../conversations/conversations.service';
import { getLLMProvider } from './providers/llm-provider.factory';
import { llmConfig } from './providers/llm-config';
import type {
  AgentChatParams,
  ProviderCapabilities,
} from './providers/llm-provider.interface';
import type {
  AgentMessage,
  AgentOutput,
  MessagePart,
} from './types/agent-message.types';
import type { AgentConfig } from './types/capabilities.types';
import { sanitize } from '../common/utils/sanitize-log.util';
import { resolvePromptTemplateString } from '../common/utils/prompt-variables.util';
import { AgentConfigResolver } from './services/agent-config-resolver.service';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  type ActivationConditionGroup,
} from './utils/condition-evaluator.util';
import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { RagSearchService } from './services/rag-search.service';
import { ToolCallDispatcher } from './services/tool-call-dispatcher.service';

export interface ProcessMessageResult {
  responseText: string;
  responseMessageId?: string;
  responseParts?: AgentMessage['parts'];
  agentId?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
  citations?: AgentOutput['citations'];
  hadTools: boolean;
  calledTools: string[];
}

import { ModelPricingService } from './services/model-pricing.service';
import { ProviderCircuitBreakerService } from './services/circuit-breaker.service';
import { FallbackProviderService } from './services/fallback-provider.service';
import { retryWithBackoff } from './utils/retry-with-backoff.util';
import { CrmDataTransformerService } from '../common/services/crm-data-transformer.service';
import { AnalyticsService } from '../analytics/analytics.service';

@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsService: ConversationsService,
    private readonly agentConfigResolver: AgentConfigResolver,
    private readonly providerKeyResolver: ProviderKeyResolverService,
    private readonly ragSearchService: RagSearchService,
    private readonly toolCallDispatcher: ToolCallDispatcher,
    private readonly modelPricingService: ModelPricingService,
    private readonly circuitBreaker: ProviderCircuitBreakerService,
    private readonly fallbackProviderService: FallbackProviderService,
    private readonly crmDataTransformer: CrmDataTransformerService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async processMessage(
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    text: string,
    requestId?: string,
  ): Promise<ProcessMessageResult> {
    const state: Record<string, unknown> = {
      ...(await this.conversationsService.getState(conversationId)),
      mensagem_usuario: text,
      user_message: text,
      last_message: text,
      message: text,
      text,
      texto: text,
    };
    const conversation =
      await this.conversationsService.getConversation(conversationId);

    const hadPendingAgent = Boolean(state.pending_agent_id);

    const agentConfig = await this.agentConfigResolver.resolveAgentConfig(
      clientId,
      state,
      conversation.origin_channel || undefined,
    );

    await this.conversationsService.updateState(conversationId, {
      ...state,
      ...(hadPendingAgent ? { pending_agent_id: null } : {}),
      current_agent_id: agentConfig.agentId,
    });

    const llmProvider = (agentConfig as any).llmProvider || llmConfig.provider;
    const apiKey = await this.providerKeyResolver.resolveApiKey(
      clientId,
      llmProvider,
    );
    const provider = getLLMProvider(llmProvider, apiKey);
    const providerCapabilities = provider.getCapabilities?.() || {
      text: true,
      vision: false,
      audio: false,
      tools: false,
    };

    const agentRun = await this.prisma.agent_runs.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        inbound_message_id: messageId,
        request_id: requestId || null,
        agent_id: agentConfig.id === 'default' ? null : agentConfig.id,
        provider:
          (agentConfig as any).llmProvider ||
          process.env.LLM_PROVIDER ||
          'gemini',
        model: agentConfig.model || llmConfig.models.gemini,
        status: 'running',
      },
    });

    const inboundMessage = await this.prisma.messages.findUnique({
      where: { id: messageId },
      include: {
        message_parts: { orderBy: { order_index: 'asc' } },
        media_assets: true,
      },
    });

    await this.waitForMediaProcessing(messageId);

    const updatedMessage =
      (await this.prisma.messages.findUnique({
        where: { id: messageId },
        include: {
          message_parts: { orderBy: { order_index: 'asc' } },
          media_assets: true,
        },
      })) || inboundMessage;

    const inputParts = await this.buildInputParts(
      updatedMessage,
      agentConfig,
      providerCapabilities,
    );

    const history = await this.buildHistory(
      conversationId,
      messageId,
      agentConfig,
      providerCapabilities,
    );

    let ragContext: string | undefined;
    try {
      ragContext = await this.ragSearchService.buildRagContext(
        agentConfig,
        text,
        clientId,
        agentRun.id,
        conversationId,
        messageId,
        companyId,
        requestId,
      );
    } catch (ragError) {
      this.logger.warn(
        { error: (ragError as Error).message },
        'RAG search failed, continuing without context',
      );
    }

    const hasMedia = inputParts.some(
      (p) =>
        p.type === 'text' &&
        (p.text?.includes('<transcricao_imagem>') ||
          p.text?.includes('<transcricao_audio>')),
    );

    const mediaInstruction = hasMedia
      ? `\n\nO usuario enviou uma imagem ou audio. A transcricao esta disponivel nos formatos abaixo. Responda como se estivesse vendo/ouvindo o conteudo:\n- Imagem: <transcricao_imagem>descricao</transcricao_imagem>\n- Audio: <transcricao_audio>transcricao</transcricao_audio>`
      : '';

    const systemPrompt = await this.resolvePromptVariables(
      ragContext
        ? `${agentConfig.system_prompt}\n\nContexto RAG disponivel:\n${ragContext}\n\nUse o contexto apenas quando ele for relevante.${mediaInstruction}`
        : agentConfig.system_prompt + mediaInstruction,
      clientId,
      state,
    );

    const tools = this.buildToolDefinitions(agentConfig);

    const params: AgentChatParams = {
      systemPrompt,
      input: { text, parts: inputParts },
      history,
      capabilities: agentConfig.capabilities,
      tools,
      agentConfig: {
        model: agentConfig.model || llmConfig.models.gemini,
        temperature: agentConfig.temperature,
        citation_policy: agentConfig.citation_policy.policy,
      },
      ragContext,
      onToolCall: async (toolName, args) => {
        const result = await this.toolCallDispatcher.dispatch(
          String(toolName),
          args || {},
          agentConfig,
          agentRun.id,
          conversationId,
          messageId,
          companyId,
          clientId,
          state,
          requestId,
          async (query, limit) => {
            return this.ragSearchService.searchRag(
              agentConfig,
              query,
              clientId,
              limit,
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              requestId,
            );
          },
        );

        if (result && typeof result === 'object') {
          const resultRecord = result as Record<string, unknown>;
          const returnedState =
            resultRecord.data && typeof resultRecord.data === 'object'
              ? (resultRecord.data as Record<string, unknown>)
              : resultRecord;
          Object.assign(state, returnedState);

          // Transição pós-API: avalia as condições de ativação dos outros
          // agentes sobre o estado enriquecido com o retorno
          const activation = await this.findActivationAfterApi(
            clientId,
            agentConfig.agentId,
            state,
          );
          if (activation) {
            state.pending_agent_id = null;
            state.current_agent_id = activation.agent.id;
            state.switch_reason = `Condição de ativação atendida após retorno de API (modo: ${activation.mode})`;
            await this.conversationsService.updateState(conversationId, state);
            this.logger.log(
              {
                from: sanitize(agentConfig.agentId),
                to: sanitize(
                  activation.agent.service_step || activation.agent.id,
                ),
                mode: activation.mode,
              },
              'Transição de agente pós-retorno de API',
            );
          }
        }

        return result;
      },
    };

    let activeProvider = provider;
    let activeProviderName = llmProvider;
    let activeModel = agentConfig.model || llmConfig.models.gemini;
    let fallbackUsed = false;

    // 1. Verifica se o circuito do provedor primário está aberto
    const canUsePrimary = await this.circuitBreaker.canExecute(
      llmProvider,
      clientId,
    );
    if (!canUsePrimary) {
      this.logger.warn(
        { provider: llmProvider, clientId },
        'Circuito aberto para provedor primário. Tentando fallback imediato',
      );
      const fallback = await this.fallbackProviderService.resolveFallback(
        clientId,
        llmProvider,
        activeModel,
      );
      if (fallback.hasFallback && fallback.target) {
        activeProviderName = fallback.target.provider;
        activeModel = fallback.target.model;
        activeProvider = getLLMProvider(
          fallback.target.provider,
          fallback.target.apiKey,
        );
        params.agentConfig.model = activeModel;
        fallbackUsed = true;
      }
    }

    let output: any = null;
    let legacyOutput: { text: string; usage?: any } | null = null;

    try {
      if (activeProvider.chatWithParts) {
        this.logger.log(
          {
            conversationId: sanitize(conversationId),
            companyId: sanitize(companyId),
            provider: activeProviderName,
            model: activeModel,
            fallbackUsed,
          },
          'Processing with chatWithParts',
        );

        output = await retryWithBackoff(
          async () => activeProvider.chatWithParts!(params),
          {
            maxRetries: 2,
            initialDelayMs: 300,
            onRetry: (err, attempt) => {
              this.logger.warn(
                { attempt, error: (err as Error).message },
                'Retry na chamada de LLM',
              );
            },
          },
        );

        await this.circuitBreaker.recordSuccess(activeProviderName, clientId);
      } else {
        const legacyHistory = history.map((msg) => {
          let content = '';
          if (msg.parts && Array.isArray(msg.parts)) {
            content = msg.parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n');
          }
          return {
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content,
          };
        });

        legacyOutput = await retryWithBackoff(
          async () =>
            activeProvider.chat({
              systemPrompt: agentConfig.system_prompt + mediaInstruction,
              userMessage: [
                text,
                ...inputParts.filter((p) => p.type === 'text').map((p) => p.text),
              ]
                .filter(Boolean)
                .join('\n'),
              history: legacyHistory,
              publicTools: [],
              allToolsList: [],
              executeExternalApiCallback: async () => ({}),
            }),
          { maxRetries: 2, initialDelayMs: 300 },
        );

        await this.circuitBreaker.recordSuccess(activeProviderName, clientId);
      }
    } catch (primaryError) {
      // Somente falhas do PROVEDOR LLM chegam aqui: persistência fora deste
      // try nunca penaliza o circuit breaker nem re-executa tools
      await this.circuitBreaker.recordFailure(
        activeProviderName,
        primaryError,
        clientId,
      );

      // Se ainda não tiver usado fallback, tenta recuperar no provedor de fallback
      if (!fallbackUsed) {
        const fallback = await this.fallbackProviderService.resolveFallback(
          clientId,
          activeProviderName,
          activeModel,
        );

        if (fallback.hasFallback && fallback.target) {
          this.logger.log(
            { from: activeProviderName, to: fallback.target.provider },
            'Executando fallback automático após falha no provedor primário',
          );

          try {
            const fallbackProvider = getLLMProvider(
              fallback.target.provider,
              fallback.target.apiKey,
            );
            params.agentConfig.model = fallback.target.model;

            if (fallbackProvider.chatWithParts) {
              output = await fallbackProvider.chatWithParts(params);
              activeModel = fallback.target.model;
              activeProviderName = fallback.target.provider;
              await this.circuitBreaker.recordSuccess(
                fallback.target.provider,
                clientId,
              );
            } else {
              await this.circuitBreaker.recordSuccess(
                fallback.target.provider,
                clientId,
              );
            }
          } catch (fallbackError) {
            await this.circuitBreaker.recordFailure(
              fallback.target.provider,
              fallbackError,
              clientId,
            );
          }
        }
      }

      if (!output) {
        await this.failAgentRun(agentRun.id, primaryError);
        throw primaryError;
      }
    }

    // Persistência fora do try do provedor: erro de banco após o LLM responder
    // não dispara fallback (que re-executaria todas as tools do turno)
    if (output) {
      const result = await this.handleOutput(
        conversationId,
        companyId,
        requestId,
        output,
        [],
      );
      await this.completeAgentRun(
        agentRun.id,
        'success',
        result.responseMessageId,
        output.usage,
        activeModel,
        activeProviderName,
      );
      return { ...result, agentId: agentConfig.agentId };
    }

    if (legacyOutput) {
      const responseMessage = await this.conversationsService.addMessage({
        conversation_id: conversationId,
        company_id: companyId,
        sender_type: 'ai',
        channel: 'internal',
        direction: 'outbound',
        message_type: 'text',
        content: legacyOutput.text,
        request_id: requestId,
      });

      await this.completeAgentRun(
        agentRun.id,
        'success',
        responseMessage.id,
        legacyOutput.usage,
        activeModel,
        activeProviderName,
      );

      return {
        responseText: legacyOutput.text,
        responseMessageId: responseMessage.id,
        agentId: agentConfig.agentId,
        hadTools: false,
        calledTools: [],
      };
    }

    throw new Error(
      'Nenhum output produzido pelo provedor LLM (nem fallback disponível)',
    );
  }

  private async waitForMediaProcessing(messageId: string): Promise<void> {
    const started = Date.now();
    const timeoutMs = 15_000;
    const intervalMs = 2_000;

    while (Date.now() - started < timeoutMs) {
      const pending = await this.prisma.media_assets.findFirst({
        where: {
          message_id: messageId,
          status: { in: ['pending', 'processing'] },
        },
      });

      if (!pending) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    this.logger.warn({ messageId }, 'Timeout waiting for media processing');
  }

  private async buildInputParts(
    message: any,
    agentConfig: AgentConfig,
    providerCapabilities: ProviderCapabilities,
  ): Promise<Omit<MessagePart, 'order_index'>[]> {
    const parts: Omit<MessagePart, 'order_index'>[] = [];

    if (!message?.message_parts) return parts;

    for (const part of message.message_parts) {
      if (part.part_type === 'text') {
        parts.push({ type: 'text', text: part.text_content || '' });
      }

      if (part.part_type === 'image') {
        if (providerCapabilities.vision && agentConfig.capabilities.vision) {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          if (asset?.storage_path) {
            parts.push({
              type: 'image',
              media_asset_id: asset.id,
              media_url: `${asset.storage_bucket}/${asset.storage_path}`,
            });
          }
        } else {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          const description = asset?.ocr_text || 'sem descricao disponivel';
          parts.push({
            type: 'text',
            text: `<transcricao_imagem>\n${description}\n</transcricao_imagem>`,
          });
        }
      }

      if (part.part_type === 'audio') {
        if (providerCapabilities.audio && agentConfig.capabilities.audio_in) {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          if (asset?.storage_path) {
            parts.push({
              type: 'audio',
              media_asset_id: asset.id,
              media_url: `${asset.storage_bucket}/${asset.storage_path}`,
            });
          }
        } else {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          const transcript = asset?.transcript || 'sem transcricao disponivel';
          parts.push({
            type: 'text',
            text: `<transcricao_audio>\n${transcript}\n</transcricao_audio>`,
          });
        }
      }

      if (part.part_type === 'file') {
        parts.push({
          type: 'file',
          text: `[Arquivo: ${part.text_content || part.media_asset_id || 'anexo'}]`,
        });
      }
    }

    return parts;
  }

  private async buildHistory(
    conversationId: string,
    currentMessageId: string,
    agentConfig: AgentConfig,
    providerCapabilities: ProviderCapabilities,
  ): Promise<AgentMessage[]> {
    const conversation =
      await this.conversationsService.getConversation(conversationId);
    const messages = (conversation as any).messages || [];

    const history: AgentMessage[] = [];

    for (const msg of messages.slice(-20)) {
      if (msg.id === currentMessageId) continue;

      const parts: MessagePart[] = [];

      if (msg.content) {
        parts.push({ type: 'text', text: msg.content, order_index: 0 });
      }

      if (msg.message_parts) {
        for (const part of msg.message_parts) {
          if (part.part_type === 'text' && part.text_content) {
            parts.push({
              type: 'text',
              text: part.text_content,
              order_index: part.order_index,
            });
          }
          if (part.part_type === 'image') {
            const asset = msg.media_assets?.find(
              (a: any) => a.id === part.media_asset_id,
            );
            if (
              providerCapabilities.vision &&
              agentConfig.capabilities.vision &&
              asset?.storage_path
            ) {
              parts.push({
                type: 'image',
                media_asset_id: asset.id,
                media_url: `${asset.storage_bucket}/${asset.storage_path}`,
                order_index: part.order_index,
              });
            } else {
              parts.push({
                type: 'text',
                text: `<transcricao_imagem>\n${asset?.ocr_text || 'sem descricao'}\n</transcricao_imagem>`,
                order_index: part.order_index,
              });
            }
          }
          if (part.part_type === 'audio') {
            const asset = msg.media_assets?.find(
              (a: any) => a.id === part.media_asset_id,
            );
            if (
              providerCapabilities.audio &&
              agentConfig.capabilities.audio_in &&
              asset?.storage_path
            ) {
              parts.push({
                type: 'audio',
                media_asset_id: asset.id,
                media_url: `${asset.storage_bucket}/${asset.storage_path}`,
                order_index: part.order_index,
              });
            } else {
              parts.push({
                type: 'text',
                text: `<transcricao_audio>\n${asset?.transcript || 'sem transcricao'}\n</transcricao_audio>`,
                order_index: part.order_index,
              });
            }
          }
        }
      }

      history.push({
        role: msg.sender_type === 'ai' ? 'assistant' : 'user',
        parts:
          parts.length > 0
            ? parts
            : [{ type: 'text', text: '', order_index: 0 }],
      });
    }

    return history;
  }

  /**
   * Avalia as condições de ativação dos outros agentes após o retorno de uma
   * API/tool, sobre o estado enriquecido. Retorna o primeiro agente (por
   * execution_order) cujas condições foram satisfeitas e seu modo de ativação.
   */
  private async findActivationAfterApi(
    clientId: string,
    currentAgentId: string,
    state: Record<string, unknown>,
  ): Promise<{ agent: any; mode: string } | null> {
    try {
      const agents = await this.prisma.painel_agents.findMany({
        where: { client_id: clientId, is_active: true },
        select: {
          id: true,
          service_step: true,
          activation_conditions: true,
          activation_mode: true,
        },
        orderBy: { execution_order: 'asc' },
      });

      for (const agent of agents) {
        if (agent.id === currentAgentId) continue;
        const conditions =
          agent.activation_conditions as ActivationConditionGroup | null;
        if (!conditions?.conditions?.length) continue;
        const evaluation = evaluateConditionsWithDetails(conditions, state);
        if (evaluation.matched) {
          return { agent, mode: agent.activation_mode || 'on_next_message' };
        }
        this.logger.debug(
          `Condição de ativação não atendida para "${agent.service_step}": ${describeEvaluation(evaluation)}`,
        );
      }
      return null;
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Falha ao avaliar condições de ativação pós-API',
      );
      return null;
    }
  }

  private buildToolDefinitions(agentConfig: AgentConfig) {
    const tools: any[] = [];

    if (
      agentConfig.capabilities.rag ||
      agentConfig.allowed_knowledge_base_ids.length > 0
    ) {
      tools.push(this.ragSearchService.ragToolDefinition());
    }

    if (agentConfig.capabilities.web_search && agentConfig.web_search_allowed) {
      tools.push(this.toolCallDispatcher.webSearchToolDefinition());
    }

    if (agentConfig.capabilities.tools) {
      tools.push(this.toolCallDispatcher.mediaTranscribeToolDefinition());
      tools.push(this.toolCallDispatcher.mediaDescribeImageToolDefinition());
      // Habilitável por agente: só é injetada se selecionada nas ferramentas
      if (agentConfig.allowed_tool_names.includes('transfer_to_human')) {
        tools.push(this.toolCallDispatcher.transferToHumanToolDefinition());
      }
    }

    return tools;
  }

  private async handleOutput(
    conversationId: string,
    companyId: string,
    requestId: string | undefined,
    output: AgentOutput,
    calledTools: string[],
  ): Promise<ProcessMessageResult> {
    const message = await this.conversationsService.addMessage({
      conversation_id: conversationId,
      company_id: companyId,
      sender_type: 'ai',
      channel: 'internal',
      direction: 'outbound',
      message_type: output.parts ? 'mixed' : 'text',
      content: output.text,
      request_id: requestId,
    });

    try {
      const conv = await this.prisma.conversations.findUnique({
        where: { id: conversationId },
        include: {
          end_users: true,
          painel_clients: { select: { metadata: true } },
        },
      });

      if (conv) {
        const clientMeta =
          (conv.painel_clients?.metadata as Record<string, unknown>) || {};
        const crmOutputConfig = (clientMeta.crm_output_config as any) || null;
        const freshState =
          await this.conversationsService.getState(conversationId);

        // Analytics: avaliação dos marcadores de negócio sobre o estado pós-tool
        if (conv.client_id) {
          await this.analyticsService.evaluateAndRecord({
            clientId: conv.client_id,
            companyId,
            conversationId,
            endUserId: conv.end_user_id || null,
            originChannel: conv.origin_channel || null,
            toolNames: calledTools,
            state: freshState as Record<string, unknown>,
          });
        }

        const crmRecord = this.crmDataTransformer.transform({
          sessionState: freshState,
          endUser: conv.end_users,
          conversation: conv,
          config: crmOutputConfig,
        });

        const existingMeta = (conv.metadata as Record<string, unknown>) || {};
        await this.prisma.conversations.update({
          where: { id: conversationId },
          data: {
            metadata: {
              ...existingMeta,
              crm_record: crmRecord,
            } as any,
          },
        });
      }
    } catch (crmErr) {
      this.logger.warn(
        { error: (crmErr as Error).message },
        'Falha ao atualizar crm_record no handleOutput',
      );
    }

    return {
      responseText: output.text,
      responseMessageId: message.id,
      responseParts: output.parts,
      hadTools: calledTools.length > 0,
      calledTools,
      citations: output.citations,
    };
  }

  private async completeAgentRun(
    agentRunId: string,
    status: string,
    responseMessageId?: string,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    },
    model?: string,
    provider?: string,
  ) {
    const current = await this.prisma.agent_runs.findUnique({
      where: { id: agentRunId },
    });

    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;

    const cost = this.modelPricingService.calculateTokenCost({
      provider: provider || current?.provider || undefined,
      model: model || current?.model || undefined,
      inputTokens,
      outputTokens,
    });

    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        status,
        response_message_id: responseMessageId || null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost,
        completed_at: new Date(),
        latency_ms: current?.started_at
          ? Date.now() - current.started_at.getTime()
          : null,
      },
    });
  }

  private async failAgentRun(agentRunId: string, error: unknown) {
    await this.completeAgentRun(agentRunId, 'failed');
    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        error_message:
          error instanceof Error ? error.message : 'Agent run failed',
      },
    });
  }

  private async resolvePromptVariables(
    prompt: string | null,
    clientId: string,
    state: Record<string, unknown>,
  ): Promise<string> {
    if (!prompt) return '';

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { agent_name: true, metadata: true },
    });

    const metadata = (client?.metadata as Record<string, unknown>) || {};
    const schema =
      (metadata.variable_schema as Record<string, unknown>) || null;

    let crmInstruction = '';
    if (schema && Array.isArray(schema.fields) && schema.fields.length > 0) {
      const fieldList = schema.fields
        .map(
          (f: any) =>
            `- ${f.key} (${f.label || f.key}, tipo: ${f.type || 'text'}${f.required ? ', OBRIGATÓRIO' : ''})${f.description ? ': ' + f.description : ''}`,
        )
        .join('\n');

      crmInstruction = `\n\n[DIRETRIZES DE CRM & COLETA DE DADOS - OPERAÇÃO: ${String(schema.operation_type || 'GERAL').toUpperCase()}]\nColete ou confirme os seguintes campos durante o atendimento (eles são persistidos automaticamente no CRM pela plataforma):\n${fieldList}\nSempre que o cliente fornecer um desses dados, confirme-o claramente na conversa e, se houver uma API disponível para registrá-lo, utilize-a.`;
    }

    const variables: Record<string, unknown> = {
      nome_agente: client?.agent_name || '',
    };

    for (const [key, value] of Object.entries(state)) {
      if (value !== null && value !== undefined) {
        variables[key] = value;
      }
    }

    const fullPrompt = prompt + crmInstruction;
    return resolvePromptTemplateString(fullPrompt, variables);
  }
}
