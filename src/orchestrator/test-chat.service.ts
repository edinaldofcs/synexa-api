import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import type { ClearTestChatDto, TestChatDto } from './dto/test-chat.dto';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  type ActivationConditionGroup,
} from './utils/condition-evaluator.util';
import { WebSearchService } from '../agents/web-search/web-search.service';
import { RagSearchService } from './services/rag-search.service';
import {
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type AgentConfig,
} from './types/capabilities.types';
import { resolvePromptTemplateString } from '../common/utils/prompt-variables.util';
import {
  InboundDataMapperService,
  InboundMappingConfig,
} from '../common/services/inbound-data-mapper.service';

interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const TEST_CHAT_CONTEXT_KEY = 'test_chat_context_variables';
const RAG_SEARCH_TOOL_ID = 'rag_search';

// Nomes legados gravados por seeds/versões antigas que não correspondem a
// ferramentas reais; são ignorados ao carregar as tools do agente
const LEGACY_TOOL_NAMES = new Set([
  'execute_api',
  'search_knowledge_base',
  'search_web',
  'set_variable',
  'save_crm_data',
  'update_crm_data',
]);

// Tool nativa habilitável por agente via allowed_tool_names
const HANDOFF_TOOL_NAME = 'transfer_to_human';

interface ApiTool {
  id: string;
  name: string;
  functionName: string;
  description?: string | null;
  method?: string | null;
  url?: string | null;
  headers?: unknown;
  body?: unknown;
  parameters?: unknown;
  extract_data?: unknown;
}

export interface TestChatDebug {
  conversationId?: string;
  externalUserId?: string;
  originChannel: string;
  provider?: string;
  model?: string;
  agentId?: string;
  memory: {
    source: 'redis' | 'database' | 'none';
    messagesUsed: number;
  };
  contextVariables: Record<string, unknown>;
  availableTools: string[];
  toolCalls: Array<{
    name: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
  }>;
  crmRecord?: Record<string, unknown>;
}

type ToolCallDebug = TestChatDebug['toolCalls'][number];

interface NativeRagRuntimeContext {
  agentConfig?: AgentConfig;
  clientId: string;
  companyId: string;
  conversationId?: string;
  messageId?: string;
  agentRunId?: string;
}

import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { ModelPricingService } from './services/model-pricing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { MediaService } from '../media/media.service';
import { CrmDataTransformerService } from '../common/services/crm-data-transformer.service';

@Injectable()
export class TestChatService {
  private readonly logger = new Logger(TestChatService.name);
  private readonly memoryLimit = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly webSearchService: WebSearchService,
    private readonly ragSearchService: RagSearchService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
    private readonly modelPricingService: ModelPricingService,
    private readonly conversationsService: ConversationsService,
    private readonly mediaService: MediaService,
    private readonly crmDataTransformer: CrmDataTransformerService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async listModels(
    provider: string,
    apiKey?: string,
    clientId?: string,
  ): Promise<string[]> {
    const isMaskedOrPlaceholder = (k?: string | null) =>
      !k ||
      k.trim() === '' ||
      k === 'stored' ||
      k === 'undefined' ||
      k === 'null' ||
      k.includes('***') ||
      k.includes('...') ||
      k.startsWith('enc:');

    let finalKey = isMaskedOrPlaceholder(apiKey) ? '' : apiKey?.trim() || '';

    if (!finalKey) {
      finalKey = await this.providerKeyResolver.resolveApiKey(
        clientId || '',
        provider,
      );
    }

    switch (provider.toLowerCase()) {
      case 'gemini':
        return this.listGeminiModels(finalKey);
      case 'groq':
        return this.listGroqModels(finalKey);
      case 'openrouter':
        return this.listOpenRouterModels(finalKey);
      default:
        throw new Error(`Provedor desconhecido: ${provider}`);
    }
  }

  async clear(dto: ClearTestChatDto) {
    const originChannel = dto.originChannel || 'webchat_test';
    const conversations = await this.prisma.conversations.findMany({
      where: {
        client_id: dto.clientId,
        origin_channel: originChannel,
        external_conversation_key: `${originChannel}:${dto.externalUserId}`,
      },
      select: { id: true },
    });

    for (const conversation of conversations) {
      await this.redisService.del(this.memoryKey(conversation.id));
      await this.redisService.del(`lock:test-chat:${conversation.id}`);
    }

    if (conversations.length) {
      await this.prisma.conversations.deleteMany({
        where: {
          id: { in: conversations.map((conversation) => conversation.id) },
        },
      });
    }

    return { cleared: true, conversations: conversations.length };
  }

  async send(dto: TestChatDto): Promise<{
    text: string;
    agentName?: string;
    transcription?: string;
    debug?: TestChatDebug;
  }> {
    const message = dto.message || '';
    let { provider, model, apiKey, files, systemPrompt, clientId, agentId } =
      dto;
    const originChannel = dto.originChannel || 'webchat_test';
    const externalUserId = dto.externalUserId;
    let companyId: string | undefined;
    let conversationId: string | undefined;
    let contextVariables: Record<string, unknown> = {};
    let availableTools: string[] = [];
    let apiTools: ApiTool[] = [];
    let allClientApiNames: string[] = [];
    let resolvedAgentId: string | undefined = agentId;
    let resolvedAgentName: string | undefined;
    let resolvedAgentConfig: AgentConfig | undefined;

    if (clientId) {
      const client = await this.prisma.painel_clients.findUnique({
        where: { id: clientId },
      });
      if (!client) throw new Error('Cliente nao encontrado');
      companyId = client.company_id;

      const metadata = (client.metadata as any) || {};
      const inboundConfig =
        metadata.inbound_variable_mapping as InboundMappingConfig;
      const mapper = new InboundDataMapperService();
      const mappedInbound = mapper.mapInboundData(
        metadata,
        inboundConfig,
        originChannel || 'webchat',
      );

      contextVariables = {
        ...this.sanitizeContextVariables(metadata),
        ...mappedInbound,
      };
      contextVariables.nome_agente = client.agent_name || '';
      Object.assign(contextVariables, this.withMessageAliases(message));
      if (metadata.variable_schema) {
        contextVariables._variable_schema = metadata.variable_schema;
      }

      if (!resolvedAgentId) {
        const initialAgent = await this.prisma.painel_agents.findFirst({
          where: {
            client_id: clientId,
            is_initial: true,
            is_active: true,
            interaction_mode: { in: ['text', 'both'] },
          },
        });
        if (initialAgent) {
          resolvedAgentId = initialAgent.id;
        } else {
          const firstAgent = await this.prisma.painel_agents.findFirst({
            where: {
              client_id: clientId,
              is_active: true,
              interaction_mode: { in: ['text', 'both'] },
            },
          });
          if (firstAgent) resolvedAgentId = firstAgent.id;
        }
      }

      if (externalUserId) {
        conversationId = await this.resolveConversation({
          clientId,
          companyId,
          originChannel,
          externalUserId,
        });
        const persistedContext =
          await this.loadConversationContext(conversationId);
        contextVariables = {
          ...contextVariables,
          ...persistedContext,
        };
        Object.assign(contextVariables, this.withMessageAliases(message));

        const state = await this.loadState(conversationId);
        const hadPendingAgent = Boolean(state.pending_agent_id);
        resolvedAgentId = await this.resolveAgentId(
          clientId,
          state,
          resolvedAgentId || '',
          persistedContext,
        );
        if (hadPendingAgent) {
          // Consome a transferência pendente para não colar nas próximas mensagens
          await this.saveState(conversationId, { pending_agent_id: null });
        }
      } else {
        resolvedAgentId = await this.resolveAgentId(
          clientId,
          {},
          resolvedAgentId || '',
          contextVariables,
        );
      }

      let agent: any = null;
      if (resolvedAgentId) {
        agent = await this.prisma.painel_agents.findUnique({
          where: { id: resolvedAgentId },
        });
      }

      if (agent?.interaction_mode === 'voice') {
        throw new Error(
          'Este agente está configurado apenas para atendimento por voz.',
        );
      }

      if (agent) {
        resolvedAgentName = agent.service_step || agent.id;
        resolvedAgentConfig = this.buildAgentConfigFromRecord(agent);

        const transitions = agent.transitions || {};
        provider = provider || transitions.llm_provider;
        model = model || agent.model;
        systemPrompt = systemPrompt || agent.system_prompt || undefined;
        availableTools = Array.isArray(agent.allowed_tool_names)
          ? agent.allowed_tool_names.filter(
              (tool: unknown): tool is string =>
                typeof tool === 'string' && !LEGACY_TOOL_NAMES.has(tool),
            )
          : [];
        allClientApiNames = await this.loadAllClientApiNames(clientId);
        apiTools = await this.loadApiTools(clientId, agent.id, availableTools);

        const capabilities =
          (transitions.capabilities as Record<string, boolean>) || {};
        const webSearch =
          (transitions.web_search as Record<string, unknown>) || {};
        if (capabilities.web_search !== false && webSearch.enabled !== false) {
          apiTools.push(this.buildNativeWebSearchApiTool());
        }
        if (this.canUseNativeRag(resolvedAgentConfig)) {
          apiTools.push(this.buildNativeRagApiTool());
        }
        if (availableTools.includes(HANDOFF_TOOL_NAME)) {
          apiTools.push(this.buildNativeHandoffApiTool());
        }

        const allowedSubagents = Array.isArray(transitions.allowed_subagents)
          ? (transitions.allowed_subagents as string[])
          : Array.isArray(transitions.allowed_subagent_ids)
            ? (transitions.allowed_subagent_ids as string[])
            : [];
        if (allowedSubagents.length > 0) {
          const isUuid = (val: string) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              val,
            );
          const uuids = allowedSubagents.filter(isUuid);
          const names = allowedSubagents.filter((val) => !isUuid(val));
          const orConditions: Array<{
            id?: { in: string[] };
            name?: { in: string[] };
          }> = [];
          if (uuids.length > 0) orConditions.push({ id: { in: uuids } });
          if (names.length > 0) orConditions.push({ name: { in: names } });

          if (orConditions.length > 0) {
            const subagentRecords = await this.prisma.painel_subagents.findMany(
              {
                where: {
                  client_id: clientId,
                  is_active: true,
                  OR: orConditions,
                },
              },
            );
            for (const sub of subagentRecords) {
              apiTools.push(this.buildSubagentApiTool(sub));
            }
          }
        }

        availableTools = [
          ...new Set([...availableTools, ...apiTools.map((tool) => tool.name)]),
        ];
      }

      // Inferência do provider se não informado explicitamente
      if (!provider && model) {
        if (model.toLowerCase().startsWith('gemini')) {
          provider = 'gemini';
        } else if (
          model.includes('/') ||
          model.toLowerCase().startsWith('llama')
        ) {
          provider = 'groq';
        }
      }

      // Model fallback caso provider exista mas model esteja vazio
      if (!model && provider) {
        if (provider.toLowerCase() === 'gemini') {
          model = 'gemini-2.5-flash';
        } else if (provider.toLowerCase() === 'groq') {
          model = 'llama-3.3-70b-versatile';
        } else if (provider.toLowerCase() === 'openrouter') {
          model = 'google/gemini-2.5-flash';
        }
      }

      const isMaskedOrPlaceholder = (k?: string | null) =>
        this.isMaskedOrPlaceholder(k);
      if (isMaskedOrPlaceholder(apiKey) && provider) {
        apiKey = await this.providerKeyResolver.resolveApiKey(
          clientId || '',
          provider,
        );
      } else if (provider && !isMaskedOrPlaceholder(apiKey)) {
        // Prioriza a chave cadastrada pelo cliente no painel (provider_credentials
        // / metadata com descriptografia); a chave recebida é apenas fallback
        const registeredKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          provider,
        );
        if (registeredKey) apiKey = registeredKey;
      }
    }

    if (this.isMaskedOrPlaceholder(apiKey) && provider) {
      apiKey = await this.providerKeyResolver.resolveApiKey(
        clientId || '',
        provider,
      );
    }

    if (!provider || !model || !apiKey) {
      throw new Error(
        `Configuração incompleta ou chave não encontrada para o provedor "${provider || 'desconhecido'}". Verifique a chave de API em Configurações > Provedores de IA.`,
      );
    }

    if (!conversationId || !clientId || !companyId) {
      const toolCalls: ToolCallDebug[] = [];
      const result = await this.callProvider(
        provider,
        message,
        model,
        apiKey,
        files,
        this.buildContextualSystemPrompt(systemPrompt, contextVariables),
        [],
        apiTools,
        toolCalls,
        {
          agentConfig: {} as any,
          clientId: clientId || '',
          companyId: companyId || '',
        },
      );
      contextVariables = this.mergeToolResults(
        contextVariables,
        result.toolCalls || [],
        apiTools,
        allClientApiNames,
      );
      return {
        ...result,
        debug: {
          externalUserId,
          originChannel,
          provider,
          model,
          agentId: resolvedAgentId || agentId,
          memory: { source: 'none', messagesUsed: 0 },
          contextVariables,
          availableTools,
          toolCalls,
        },
      };
    }

    const lockKey = `lock:test-chat:${conversationId}`;
    let acquired = await this.redisService.acquireLock(lockKey, 15);
    if (!acquired) {
      // Pequena espera e retry para evitar bloqueios transitórios
      await new Promise((resolve) => setTimeout(resolve, 1500));
      acquired = await this.redisService.acquireLock(lockKey, 15);
    }
    if (!acquired) {
      throw new Error(
        'Conversa em processamento. Tente novamente em instantes.',
      );
    }

    try {
      const memory = await this.loadMemory(conversationId);
      const history = memory.messages;
      const inboundContent =
        message && message.trim()
          ? message
          : files?.some((f) => f.mimeType.startsWith('audio/'))
            ? '[Áudio]'
            : files?.some((f) => f.mimeType.startsWith('image/'))
              ? `[${files.filter((f) => f.mimeType.startsWith('image/')).length} imagem(ns) enviada(s)]`
              : '[Anexo]';

      const inboundMessage = await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'customer',
        direction: 'inbound',
        channel: originChannel,
        content: inboundContent,
      });
      const agentRun = await this.startTestAgentRun({
        companyId,
        clientId,
        conversationId,
        inboundMessageId: inboundMessage.id,
        agentId: resolvedAgentId,
        provider,
        model,
      });

      let result: {
        text: string;
        toolCalls?: ToolCallDebug[];
        transcription?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      };
      try {
        result = await this.callProvider(
          provider,
          message,
          model,
          apiKey,
          files,
          this.buildContextualSystemPrompt(systemPrompt, contextVariables),
          history,
          apiTools,
          [],
          this.buildNativeRagRuntimeContext(
            resolvedAgentConfig,
            clientId,
            companyId,
            conversationId,
            inboundMessage.id,
            agentRun.id,
          ),
        );
      } catch (error) {
        await this.failTestAgentRun(agentRun.id, error, agentRun.started_at);
        throw error;
      }

      const audioTranscript = result.transcription;

      if (files?.length && companyId && clientId) {
        for (const file of files) {
          const isAudio = file.mimeType.startsWith('audio/');
          const transcript = isAudio ? audioTranscript || null : null;
          const mediaAsset = await this.mediaService.storeInlineAsset({
            companyId,
            clientId,
            messageId: inboundMessage.id,
            mimeType: file.mimeType,
            data: file.data,
            transcript,
          });
          await this.prisma.message_parts.create({
            data: {
              message_id: inboundMessage.id,
              part_type: isAudio ? 'audio' : 'image',
              media_asset_id: mediaAsset.id,
              text_content: transcript,
            },
          });
        }
      }

      if (audioTranscript) {
        await this.prisma.messages.update({
          where: { id: inboundMessage.id },
          data: {
            content: `[Áudio] ${audioTranscript}`,
          },
        });
      }

      const responseMessage = await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'ai',
        direction: 'outbound',
        channel: originChannel,
        content: result.text,
      });
      await this.completeTestAgentRun({
        agentRunId: agentRun.id,
        responseMessageId: responseMessage.id,
        usage: result.usage,
        model,
        provider,
        startedAt: agentRun.started_at,
      });

      const userMemoryContent = audioTranscript
        ? `[Áudio] ${audioTranscript}`
        : message && message.trim()
          ? message
          : '[Imagem/Documento enviado pelo cliente]';

      await this.saveMemory(conversationId, [
        ...history,
        { role: 'user', content: userMemoryContent },
        { role: 'assistant', content: result.text },
      ]);

      contextVariables = this.mergeToolResults(
        contextVariables,
        result.toolCalls || [],
        apiTools,
        allClientApiNames,
      );
      await this.saveConversationContext(conversationId, contextVariables);

      if (resolvedAgentId) {
        await this.saveState(conversationId, {
          current_agent_id: resolvedAgentId,
        });
      }

      // Transição pós-API: avalia condições de ativação sobre o estado
      // enriquecido com os retornos das APIs executadas neste turno
      if (resolvedAgentId && clientId && companyId) {
        const activation = await this.checkActivationAfterApi(
          clientId,
          resolvedAgentId,
          contextVariables,
        );
        if (activation && activation.mode === 'immediate') {
          const immediateResult = await this.processWithAgent(
            activation.agent,
            clientId,
            companyId,
            conversationId,
            originChannel,
            message,
            inboundMessage.id,
            contextVariables,
            history,
            memory,
          );
          if (immediateResult) {
            const immediateResponseMessage = await this.saveMessage({
              conversationId,
              companyId,
              clientId,
              senderType: 'ai',
              direction: 'outbound',
              channel: originChannel,
              content: immediateResult.result.text,
            });
            await this.completeTestAgentRun({
              agentRunId: immediateResult.agentRunId,
              responseMessageId: immediateResponseMessage.id,
              usage: immediateResult.result.usage,
              model: immediateResult.model,
              provider: immediateResult.provider,
              startedAt: immediateResult.startedAt,
            });
            await this.saveMemory(conversationId, [
              ...history,
              { role: 'user', content: userMemoryContent },
              { role: 'assistant', content: immediateResult.result.text || '' },
            ]);
            immediateResult.contextVariables = this.mergeToolResults(
              immediateResult.contextVariables,
              immediateResult.result.toolCalls || [],
              immediateResult.apiTools,
              allClientApiNames,
            );
            await this.saveConversationContext(
              conversationId,
              immediateResult.contextVariables,
            );
            await this.saveState(conversationId, {
              current_agent_id: activation.agent.id,
              pending_agent_id: null,
            });
            await this.syncPainelInteraction({
              companyId,
              clientId,
              agentId: activation.agent.id,
              agentName: activation.agent.service_step || activation.agent.id,
              sessionId: conversationId,
              channel: originChannel || 'webchat',
              userMessage: inboundContent,
              assistantMessage: immediateResult.result.text,
              contextVariables: immediateResult.contextVariables,
              toolCalls: immediateResult.result.toolCalls || [],
              usage: immediateResult.result.usage,
              provider: immediateResult.provider,
              model: immediateResult.model,
            });

            return {
              ...immediateResult.result,
              agentName: activation.agent.service_step || activation.agent.id,
              debug: {
                conversationId,
                externalUserId,
                originChannel,
                provider,
                model,
                agentId: activation.agent.id,
                memory: {
                  source: memory.source,
                  messagesUsed: history.length,
                },
                contextVariables: immediateResult.contextVariables,
                availableTools: immediateResult.availableTools,
                toolCalls: immediateResult.result.toolCalls || [],
              },
            };
          }
        } else if (activation) {
          // Modo "próxima mensagem": agenda o novo agente para o próximo turno
          await this.saveState(conversationId, {
            current_agent_id: activation.agent.id,
            pending_agent_id: null,
          });
        }
      }

      let crmRecord: Record<string, unknown> | undefined;
      if (conversationId) {
        try {
          const freshConv = await this.prisma.conversations.findUnique({
            where: { id: conversationId },
            include: { end_users: true },
          });

          const client = clientId
            ? await this.prisma.painel_clients.findUnique({
                where: { id: clientId },
                select: { metadata: true },
              })
            : null;
          const clientMeta =
            (client?.metadata as Record<string, unknown>) || {};
          const crmOutputConfig = (clientMeta.crm_output_config as any) || null;

          const freshState =
            await this.conversationsService.getState(conversationId);
          const combinedState = {
            ...contextVariables,
            ...freshState,
          };

          // Analytics: avaliação dos marcadores de negócio sobre o estado pós-tool
          if (clientId && companyId) {
            await this.analyticsService.evaluateAndRecord({
              clientId,
              companyId,
              conversationId,
              endUserId: freshConv?.end_user_id || null,
              originChannel: originChannel,
              toolNames: (result.toolCalls || [])
                .map((call: any) => call?.name)
                .filter(
                  (name: unknown): name is string => typeof name === 'string',
                ),
              state: combinedState,
            });
          }

          crmRecord = this.crmDataTransformer.transform({
            sessionState: combinedState,
            endUser: freshConv?.end_users,
            conversation: freshConv,
            config: crmOutputConfig,
          });

          if (freshConv) {
            const existingMeta =
              (freshConv.metadata as Record<string, unknown>) || {};
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
            'Falha ao transformar crmRecord no test-chat',
          );
        }
      }

      const finalResponse = {
        ...result,
        agentName: resolvedAgentName,
        debug: {
          conversationId,
          externalUserId,
          originChannel,
          provider,
          model,
          agentId: resolvedAgentId || agentId,
          memory: {
            source: memory.source,
            messagesUsed: history.length,
          },
          contextVariables,
          availableTools,
          toolCalls: result.toolCalls || [],
          crmRecord,
        },
      };

      // Sincroniza interação unificada (painel_interactions)
      await this.syncPainelInteraction({
        companyId,
        clientId,
        agentId: resolvedAgentId || agentId,
        agentName: resolvedAgentName,
        sessionId: conversationId,
        channel: originChannel || 'webchat',
        userMessage: inboundContent,
        assistantMessage: result.text,
        contextVariables,
        toolCalls: result.toolCalls || [],
        usage: result.usage,
        provider,
        model,
      });

      return finalResponse;
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  private async callProvider(
    provider: string,
    message: string,
    model: string,
    apiKey: string,
    files?: { mimeType: string; data: string }[],
    systemPrompt?: string,
    history: MemoryMessage[] = [],
    apiTools: ApiTool[] = [],
    toolCalls: ToolCallDebug[] = [],
    nativeRagContext?: NativeRagRuntimeContext,
  ): Promise<{
    text: string;
    toolCalls?: ToolCallDebug[];
    transcription?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }> {
    switch (provider.toLowerCase()) {
      case 'gemini':
        if (apiTools.length > 0) {
          return this.callOpenAICompatible(
            'https://generativelanguage.googleapis.com/v1beta/openai',
            message,
            model,
            apiKey,
            files,
            systemPrompt,
            history,
            apiTools,
            toolCalls,
            nativeRagContext,
          );
        }
        return this.callGemini(
          message,
          model,
          apiKey,
          files,
          systemPrompt,
          history,
        );
      case 'groq':
        return this.callOpenAICompatible(
          'https://api.groq.com/openai/v1',
          message,
          model,
          apiKey,
          files,
          systemPrompt,
          history,
          apiTools,
          toolCalls,
          nativeRagContext,
        );
      case 'openrouter':
        return this.callOpenAICompatible(
          'https://openrouter.ai/api/v1',
          message,
          model,
          apiKey,
          files,
          systemPrompt,
          history,
          apiTools,
          toolCalls,
          nativeRagContext,
        );
      default:
        throw new Error(`Provedor desconhecido: ${provider}`);
    }
  }

  private async resolveConversation(params: {
    clientId: string;
    companyId: string;
    originChannel: string;
    externalUserId: string;
  }) {
    const lockKey = `lock:test-chat-identity:${params.clientId}:${params.originChannel}:${params.externalUserId}`;
    const acquired = await this.redisService.acquireLock(lockKey, 30);
    if (!acquired) {
      throw new Error('Sessao em criacao. Tente novamente em instantes.');
    }

    try {
      const identity = await this.prisma.channel_identities.findFirst({
        where: {
          client_id: params.clientId,
          channel_type: params.originChannel,
          external_user_id: params.externalUserId,
        },
        select: { end_user_id: true },
      });

      let endUserId = identity?.end_user_id;
      if (!endUserId) {
        const endUser = await this.prisma.end_users.create({
          data: {
            company_id: params.companyId,
            client_id: params.clientId,
            metadata: { source: 'enterprise_chat_test' },
          },
        });
        endUserId = endUser.id;

        await this.prisma.channel_identities.create({
          data: {
            company_id: params.companyId,
            client_id: params.clientId,
            end_user_id: endUserId,
            channel_type: params.originChannel,
            external_user_id: params.externalUserId,
          },
        });
      }

      const existing = await this.prisma.conversations.findFirst({
        where: {
          client_id: params.clientId,
          origin_channel: params.originChannel,
          end_user_id: endUserId,
          status: { not: 'closed' },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      });
      if (existing) return existing.id;

      const conversation = await this.prisma.conversations.create({
        data: {
          company_id: params.companyId,
          client_id: params.clientId,
          end_user_id: endUserId,
          origin_channel: params.originChannel,
          external_conversation_key: `${params.originChannel}:${params.externalUserId}`,
          status: 'active',
          mode: 'auto',
          metadata: { source: 'enterprise_chat_test' },
        },
        select: { id: true },
      });

      return conversation.id;
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  private sanitizeContextVariables(metadata: Record<string, unknown>) {
    const {
      llm_providers,
      llm_providers_updated_at,
      [TEST_CHAT_CONTEXT_KEY]: _testChatContext,
      ...safeMetadata
    } = metadata || {};
    return safeMetadata;
  }

  private async loadConversationContext(conversationId: string) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const metadata = this.asRecord(conversation?.metadata);
    return this.asRecord(metadata[TEST_CHAT_CONTEXT_KEY]);
  }

  private async saveConversationContext(
    conversationId: string,
    contextVariables: Record<string, unknown>,
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const metadata = this.asRecord(conversation?.metadata);

    const nextMetadata = {
      ...metadata,
      [TEST_CHAT_CONTEXT_KEY]: contextVariables,
    } as Prisma.InputJsonObject;

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        metadata: nextMetadata,
      },
    });
  }

  private async loadState(
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    const cs = await this.prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
    });
    return (cs?.state as Record<string, unknown>) || {};
  }

  private async saveState(
    conversationId: string,
    partialState: Record<string, unknown>,
  ) {
    const existing = await this.prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
    });
    const merged = {
      ...((existing?.state as Record<string, unknown>) || {}),
      ...partialState,
    };
    await this.prisma.conversation_state.upsert({
      where: { conversation_id: conversationId },
      update: { state: merged as any, version: { increment: 1 } },
      create: {
        conversation_id: conversationId,
        state: merged as any,
      },
    });
  }

  private async resolveAgentId(
    clientId: string,
    state: Record<string, unknown>,
    defaultAgentId: string,
    contextVariables: Record<string, unknown>,
  ): Promise<string> {
    const mergedState = { ...contextVariables, ...state };

    const allAgents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        is_initial: true,
        activation_conditions: true,
        activation_mode: true,
        interaction_mode: true,
      },
      orderBy: { execution_order: 'asc' },
    });
    const agents = allAgents.filter(
      (agent) => agent.interaction_mode !== 'voice',
    );

    if (agents.length === 0) return defaultAgentId;

    // Sem avaliação de condições aqui: a primeira mensagem sempre vai para o
    // agente inicial e as condições só são avaliadas após retorno de APIs.
    // Fluxo: pendente (transferência pós-API) > atual > inicial.

    const pendingAgentId = mergedState.pending_agent_id as string | undefined;
    if (pendingAgentId) {
      const target = agents.find((a) => a.id === pendingAgentId);
      if (target) return target.id;
    }

    const currentAgentId =
      (mergedState.current_agent_id as string) || defaultAgentId;
    const currentAgent = agents.find((a) => a.id === currentAgentId);
    if (currentAgent) return currentAgent.id;

    return (agents.find((a) => a.is_initial) || agents[0]).id;
  }

  /**
   * Avalia as condições de ativação dos outros agentes após o retorno de uma
   * API/tool sobre o estado enriquecido. Retorna o primeiro agente (por
   * execution_order) cujas condições foram satisfeitas e seu modo de ativação.
   */
  private async checkActivationAfterApi(
    clientId: string,
    currentAgentId: string,
    contextVariables: Record<string, unknown>,
  ): Promise<{ agent: any; mode: string } | null> {
    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        model: true,
        system_prompt: true,
        transitions: true,
        allowed_tool_names: true,
        activation_conditions: true,
        activation_mode: true,
        interaction_mode: true,
      },
      orderBy: { execution_order: 'asc' },
    });

    for (const agent of agents) {
      if (agent.id === currentAgentId || agent.interaction_mode === 'voice') {
        continue;
      }
      const conditions =
        agent.activation_conditions as ActivationConditionGroup | null;
      if (!conditions?.conditions?.length) continue;
      const evaluation = evaluateConditionsWithDetails(
        conditions,
        contextVariables,
      );
      if (evaluation.matched) {
        return { agent, mode: agent.activation_mode || 'on_next_message' };
      }
      this.logger.debug(
        `Condição de ativação não atendida para "${agent.service_step}": ${describeEvaluation(evaluation)}`,
      );
    }

    return null;
  }

  private async processWithAgent(
    agent: any,
    clientId: string,
    companyId: string,
    conversationId: string,
    originChannel: string,
    message: string,
    inboundMessageId: string,
    contextVariables: Record<string, unknown>,
    history: MemoryMessage[],
    memory: any,
  ) {
    const transitions = agent.transitions || {};
    const provider =
      transitions.llm_provider || process.env.LLM_PROVIDER || 'groq';
    const model = agent.model || 'openai/gpt-oss-120b';

    // Sempre usa a chave cadastrada pelo cliente (provider_credentials / metadata
    // com descriptografia), caindo para variáveis de ambiente apenas se necessário
    let apiKey = await this.providerKeyResolver.resolveApiKey(
      clientId,
      provider,
    );
    if (!apiKey) {
      const envKeyName = `${provider.toUpperCase()}_API_KEY`;
      apiKey = process.env[envKeyName] || '';
    }
    if (!apiKey) {
      this.logger.warn(
        { provider },
        'processWithAgent: API Key nao encontrada para provider',
      );
      return null;
    }

    const allowedToolNames = Array.isArray(agent.allowed_tool_names)
      ? agent.allowed_tool_names.filter(
          (tool: unknown): tool is string =>
            typeof tool === 'string' && !LEGACY_TOOL_NAMES.has(tool),
        )
      : [];
    const apiTools = await this.loadApiTools(
      clientId,
      agent.id,
      allowedToolNames,
    );
    const agentConfig = this.buildAgentConfigFromRecord(agent);

    const capabilities =
      (transitions.capabilities as Record<string, boolean>) || {};
    const webSearch = (transitions.web_search as Record<string, unknown>) || {};
    if (capabilities.web_search !== false && webSearch.enabled !== false) {
      apiTools.push(this.buildNativeWebSearchApiTool());
    }
    if (this.canUseNativeRag(agentConfig)) {
      apiTools.push(this.buildNativeRagApiTool());
    }
    if (allowedToolNames.includes(HANDOFF_TOOL_NAME)) {
      apiTools.push(this.buildNativeHandoffApiTool());
    }

    const allowedSubagents = Array.isArray(transitions.allowed_subagents)
      ? (transitions.allowed_subagents as string[])
      : Array.isArray(transitions.allowed_subagent_ids)
        ? (transitions.allowed_subagent_ids as string[])
        : [];
    if (allowedSubagents.length > 0) {
      const isUuid = (val: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          val,
        );
      const uuids = allowedSubagents.filter(isUuid);
      const names = allowedSubagents.filter((val) => !isUuid(val));
      const orConditions: Array<{
        id?: { in: string[] };
        name?: { in: string[] };
      }> = [];
      if (uuids.length > 0) orConditions.push({ id: { in: uuids } });
      if (names.length > 0) orConditions.push({ name: { in: names } });

      if (orConditions.length > 0) {
        const subagentRecords = await this.prisma.painel_subagents.findMany({
          where: {
            client_id: clientId,
            is_active: true,
            OR: orConditions,
          },
        });
        for (const sub of subagentRecords) {
          apiTools.push(this.buildSubagentApiTool(sub));
        }
      }
    }

    const availableTools = [
      ...new Set([...allowedToolNames, ...apiTools.map((t) => t.name)]),
    ];

    const agentRun = await this.startTestAgentRun({
      companyId,
      clientId,
      conversationId,
      inboundMessageId,
      agentId: agent.id,
      provider,
      model,
    });

    let result: {
      text: string;
      toolCalls?: ToolCallDebug[];
      transcription?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
    };
    try {
      result = await this.callProvider(
        provider,
        message,
        model,
        apiKey,
        undefined,
        this.buildContextualSystemPrompt(
          agent.system_prompt || undefined,
          contextVariables,
        ),
        history,
        apiTools,
        [],
        this.buildNativeRagRuntimeContext(
          agentConfig,
          clientId,
          companyId,
          conversationId,
          inboundMessageId,
          agentRun.id,
        ),
      );
    } catch (error) {
      await this.failTestAgentRun(agentRun.id, error, agentRun.started_at);
      throw error;
    }

    return {
      result,
      agentRunId: agentRun.id,
      model,
      provider,
      startedAt: agentRun.started_at,
      apiTools,
      availableTools,
      contextVariables,
    };
  }

  private buildContextualSystemPrompt(
    systemPrompt: string | undefined,
    contextVariables: Record<string, unknown>,
  ) {
    const schema =
      (contextVariables._variable_schema as Record<string, unknown>) || null;
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

    const entries = Object.entries(contextVariables).filter(
      ([key, value]) => value !== undefined && !key.startsWith('_'),
    );
    if (!entries.length && !crmInstruction) return systemPrompt;

    const basePrompt = (systemPrompt || '') + crmInstruction;
    const replacedPrompt = resolvePromptTemplateString(
      basePrompt,
      contextVariables,
    );

    if (!entries.length) return replacedPrompt;

    const contextBlock = entries
      .map(([key, value]) => `- [[${key}]]: ${this.formatContextValue(value)}`)
      .join('\n');

    return [
      replacedPrompt,
      'Contexto persistido desta conversa:',
      contextBlock,
      'Use esses valores como memoria de trabalho quando forem relevantes para a resposta.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private isMaskedOrPlaceholder(k?: string | null) {
    return (
      !k ||
      k.trim() === '' ||
      k === 'stored' ||
      k === 'undefined' ||
      k === 'null' ||
      k.includes('***') ||
      k.includes('...') ||
      k.startsWith('enc:')
    );
  }

  private withMessageAliases(message: string): Record<string, unknown> {
    return {
      mensagem_usuario: message,
      user_message: message,
      last_message: message,
      message,
      text: message,
      texto: message,
      user_transcript: message,
    };
  }

  private formatContextValue(value: unknown) {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private mergeToolResults(
    contextVariables: Record<string, unknown>,
    toolCalls: ToolCallDebug[],
    apiTools: ApiTool[],
    allClientApiNames: string[],
  ) {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[\s_()]+/g, '')
        .trim();

    const agentApiNames = new Set(apiTools.map((t) => normalize(t.name)));
    const allNormalized = allClientApiNames.map((n) => normalize(n));

    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(contextVariables)) {
      const keyNorm = normalize(key);
      const isApiName = allNormalized.some((n) => n === keyNorm);
      if (isApiName && !agentApiNames.has(keyNorm)) continue;
      merged[key] = value;
    }

    for (const toolCall of toolCalls) {
      // 1. Salva dados extraídos do retorno da API
      const resultData = (toolCall.result as any)?.data;
      if (resultData && typeof resultData === 'object') {
        Object.assign(merged, resultData);
      }

      // 2. Salva campos enviados no Body / Parâmetros configurados para persistir na sessão
      const matchedTool = apiTools.find(
        (t) =>
          t.name === toolCall.name ||
          t.functionName === toolCall.name ||
          normalize(t.name) === normalize(toolCall.name),
      );
      if (matchedTool && toolCall.arguments) {
        const bodyConfig = this.asRecord(matchedTool.body);
        const paramConfig = this.asRecord(matchedTool.parameters);
        const allConfigs = { ...paramConfig, ...bodyConfig };

        for (const [key, cfg] of Object.entries(allConfigs)) {
          const fieldCfg = this.asRecord(cfg);
          if (
            fieldCfg.save_to_session === true ||
            fieldCfg.save_to_session === 'true' ||
            fieldCfg.save_to_context === true ||
            fieldCfg.save_to_state === true
          ) {
            const sessionVarName =
              typeof fieldCfg.session_variable === 'string' &&
              fieldCfg.session_variable.trim()
                ? fieldCfg.session_variable.trim()
                : key.replace(/\./g, '_');

            let val = (toolCall.arguments as Record<string, unknown>)[key];
            if (val === undefined && key.includes('.')) {
              const leafKey = key.split('.').pop()!;
              val = (toolCall.arguments as Record<string, unknown>)[leafKey];
            }
            if (val !== undefined) {
              merged[sessionVarName] = val;
            }
          }
        }
      }
    }

    merged.available_apis = apiTools.map((t) => ({
      name: t.name,
      description: t.description,
      method: t.method,
    }));

    return merged;
  }

  private async loadApiTools(
    clientId: string,
    agentId: string,
    allowedToolNames: string[],
  ): Promise<ApiTool[]> {
    const allowedNames = new Set(allowedToolNames);
    const filter =
      allowedNames.size > 0
        ? { name: { in: [...allowedNames] } }
        : { agent_id: agentId };

    const apis = await this.prisma.painel_apis.findMany({
      where: {
        client_id: clientId,
        active: true,
        visible_to_agent: true,
        ...filter,
      },
      orderBy: { execution_order: 'asc' },
    });

    return apis.map((api) => ({
      id: api.id,
      name: api.name,
      functionName: this.toFunctionName(api.name, api.id),
      description: api.description,
      method: api.method,
      url: api.url,
      headers: api.headers,
      body: api.body,
      parameters: api.parameters,
      extract_data: api.extract_data,
    }));
  }

  private async loadAllClientApiNames(clientId: string): Promise<string[]> {
    const apis = await this.prisma.painel_apis.findMany({
      where: { client_id: clientId, active: true },
      select: { name: true },
    });
    return apis.map((api) => api.name);
  }

  private toFunctionName(name: string, id: string) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
      .toLowerCase();
    return `${slug || 'tool'}_${id.replace(/-/g, '_')}`;
  }

  private buildNativeWebSearchApiTool(): ApiTool {
    const def = this.webSearchService.getToolDefinition();
    const id = this.webSearchService.getNativeToolId();
    return {
      id,
      name: def.name,
      functionName: id,
      description: def.description,
      method: 'NATIVE',
      url: null,
      headers: null,
      body: null,
      parameters: def.parameters,
      extract_data: null,
    };
  }

  private buildNativeRagApiTool(): ApiTool {
    const def = this.ragSearchService.ragToolDefinition();
    return {
      id: RAG_SEARCH_TOOL_ID,
      name: def.name,
      functionName: RAG_SEARCH_TOOL_ID,
      description: def.description,
      method: 'NATIVE',
      url: null,
      headers: null,
      body: null,
      parameters: def.parameters,
      extract_data: null,
    };
  }

  private buildNativeHandoffApiTool(): ApiTool {
    return {
      id: 'transfer_to_human',
      name: 'transfer_to_human',
      functionName: 'transfer_to_human',
      description:
        'Transfere o atendimento para um atendente humano / operador. Use SEMPRE que o cliente pedir para falar com um humano, atendente, suporte humano ou quando o problema não puder ser resolvido pela IA.',
      method: 'NATIVE',
      url: null,
      headers: null,
      body: null,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Motivo da transferência para o atendente humano',
          },
        },
        required: [],
      },
      extract_data: null,
    };
  }

  private buildSubagentApiTool(subagent: {
    id: string;
    name: string;
    description: string;
  }): ApiTool {
    const fnName = `subagent_${subagent.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    return {
      id: subagent.id,
      name: fnName,
      functionName: fnName,
      description: `[SUBAGENTE ESPECIALISTA: ${subagent.name.toUpperCase()}] ${subagent.description}. Acione esta ferramenta para delegar subtarefas especializadas a este subagente.`,
      method: 'NATIVE',
      url: null,
      headers: null,
      body: null,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'Instrução ou pergunta detalhada a ser resolvida pelo subagente especialista.',
          },
          context_data: {
            type: 'string',
            description:
              'Dados adicionais de contexto do cliente ou da conversa relevantes para a tarefa.',
          },
        },
        required: ['task'],
      },
      extract_data: null,
    };
  }

  private async executeSubagentTool(
    subagentFnName: string,
    args: Record<string, unknown>,
    clientId: string,
    companyId: string,
    conversationId?: string,
  ): Promise<Record<string, unknown>> {
    const cleanName = subagentFnName.replace(/^subagent_/, '').toLowerCase();
    const isUuid = (val: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        val,
      );
    const orConditions: Array<{ id?: string; name?: string }> = [
      { name: cleanName },
    ];
    if (isUuid(cleanName)) {
      orConditions.push({ id: cleanName });
    }

    const subagent = await this.prisma.painel_subagents.findFirst({
      where: {
        ...(clientId ? { client_id: clientId } : {}),
        is_active: true,
        OR: orConditions,
      },
    });

    if (!subagent) {
      return {
        error: `Subagente "${cleanName}" não encontrado ou inativo.`,
      };
    }

    const resolvedClientId = clientId || subagent.client_id;

    try {
      const provider = subagent.llm_provider || 'gemini';
      let model = subagent.model || '';
      if (
        provider.toLowerCase() === 'gemini' &&
        (!model || model.includes('2.5') || model.includes('2.0'))
      ) {
        model = 'gemini-3.6-flash';
      } else if (!model) {
        model = 'llama-3.3-70b-versatile';
      }

      let apiKey = await this.providerKeyResolver.resolveApiKey(
        resolvedClientId,
        provider,
      );
      if (!apiKey) {
        apiKey = await this.providerKeyResolver.resolveApiKey(
          'default',
          provider,
        );
      }
      if (!apiKey) {
        if (provider.toLowerCase() === 'gemini') {
          apiKey = process.env.GEMINI_API_KEY || '';
        } else if (provider.toLowerCase() === 'groq') {
          apiKey = process.env.GROQ_API_KEY || '';
        } else if (provider.toLowerCase() === 'openrouter') {
          apiKey = process.env.OPENROUTER_API_KEY || '';
        }
      }

      if (!apiKey) {
        return {
          error: `Chave de API não configurada para o provedor ${provider} do subagente ${subagent.name}.`,
        };
      }

      const allowedToolNames = Array.isArray(subagent.allowed_tool_names)
        ? (subagent.allowed_tool_names as string[]).filter(
            (t) => typeof t === 'string',
          )
        : [];
      const subagentApiTools =
        allowedToolNames.length > 0
          ? await this.loadApiTools(resolvedClientId, '', allowedToolNames)
          : [];

      const taskPrompt =
        typeof args.task === 'string'
          ? args.task
          : JSON.stringify(args.task || '');
      const contextData =
        typeof args.context_data === 'string'
          ? args.context_data
          : args.context_data
            ? JSON.stringify(args.context_data)
            : 'Nenhum dado adicional fornecido.';

      const userMessage = `[TAREFA DELEGADA PELO SUPERVISOR]:\n${taskPrompt}\n\n[DADOS DE CONTEXTO]:\n${contextData}`;

      const subToolCalls: ToolCallDebug[] = [];
      const subResult = await this.callProvider(
        provider,
        userMessage,
        model,
        apiKey,
        [],
        subagent.system_prompt,
        [],
        subagentApiTools,
        subToolCalls,
      );

      return {
        status: 'completed',
        subagent: subagent.name,
        response: subResult.text,
        tools_executed: subToolCalls.map((tc) => tc.name),
      };
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message, subagent: subagent.name },
        'Erro na execução do subagente',
      );
      return {
        error: `Falha ao executar subagente ${subagent.name}: ${(error as Error).message}`,
      };
    }
  }

  private canUseNativeRag(
    agentConfig?: AgentConfig,
  ): agentConfig is AgentConfig {
    return Boolean(
      agentConfig?.capabilities.rag === true &&
      agentConfig.allowed_knowledge_base_ids.length > 0,
    );
  }

  private buildAgentConfigFromRecord(agent: any): AgentConfig {
    const transitions = this.asRecord(agent?.transitions);
    const capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(this.asRecord(
        transitions.capabilities,
      ) as Partial<AgentCapabilities>),
    };
    const webSearch = this.asRecord(transitions.web_search);
    const allowedKnowledgeBaseIds = Array.isArray(
      transitions.allowed_knowledge_base_ids,
    )
      ? transitions.allowed_knowledge_base_ids.filter(
          (id: unknown): id is string => typeof id === 'string',
        )
      : [];
    const allowedToolNames = Array.isArray(agent?.allowed_tool_names)
      ? agent.allowed_tool_names.filter(
          (name: unknown): name is string =>
            typeof name === 'string' && !LEGACY_TOOL_NAMES.has(name),
        )
      : [];

    return {
      id: agent?.id || 'default',
      name: agent?.service_step || agent?.id || 'default',
      model: agent?.model || '',
      system_prompt: agent?.system_prompt || '',
      capabilities,
      citation_policy: { policy: 'optional' },
      allowed_knowledge_base_ids: allowedKnowledgeBaseIds,
      allowed_tool_names: allowedToolNames,
      web_search_allowed: webSearch.enabled !== false,
      temperature: 0.3,
    };
  }

  private buildNativeRagRuntimeContext(
    agentConfig: AgentConfig | undefined,
    clientId: string,
    companyId: string,
    conversationId: string,
    messageId: string,
    agentRunId: string,
  ): NativeRagRuntimeContext | undefined {
    return {
      agentConfig,
      clientId,
      companyId,
      conversationId,
      messageId,
      agentRunId,
    };
  }

  private buildOpenAiTools(apiTools: ApiTool[]) {
    return apiTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.functionName,
        description:
          tool.description ||
          `Executa a API "${tool.name}" e retorna os dados encontrados.`,
        parameters: this.buildToolParameters(tool),
      },
    }));
  }

  private buildToolParameters(tool: ApiTool) {
    const nativeParameters = this.asRecord(tool.parameters);
    if (
      tool.method === 'NATIVE' &&
      nativeParameters.type === 'object' &&
      nativeParameters.properties
    ) {
      return {
        type: 'object',
        properties: this.asRecord(nativeParameters.properties),
        required: Array.isArray(nativeParameters.required)
          ? nativeParameters.required
          : [],
        additionalProperties:
          nativeParameters.additionalProperties === undefined
            ? false
            : nativeParameters.additionalProperties,
      };
    }

    const properties: Record<string, unknown> = {};
    const required = new Set<string>();

    for (const param of this.extractUrlParams(tool.url || '')) {
      properties[param] = {
        type: 'string',
        description: `Valor para preencher {${param}} na URL da API. IMPORTANTE: Passe sempre como string entre aspas (ex: "12345").`,
      };
      required.add(param);
    }

    const body = this.asRecord(tool.body);
    for (const [key, config] of Object.entries(body)) {
      const cfg = this.asRecord(config);
      if (cfg.source === 'null' || cfg.type === 'null') {
        continue; // Campos fixos nulos não exigem preenchimento da IA
      }
      if (cfg.source !== 'ai') continue;

      let paramType = 'string';
      let description =
        typeof cfg.value === 'string' && cfg.value.trim()
          ? cfg.value
          : `Valor do campo ${key} preenchido pela IA.`;

      if (cfg.type === 'number') {
        paramType = 'string';
        description +=
          ' (Deve ser um valor numérico formatado como string, ex: "123")';
      } else if (cfg.type === 'stringDecimal') {
        paramType = 'string';
        description +=
          ' (Deve ser um valor decimal formatado como string, ex: "123.45")';
      } else if (cfg.type === 'boolean') {
        paramType = 'boolean';
      } else if (cfg.type === 'raw' || cfg.type === 'json') {
        paramType = 'string';
        description += ' (Enviar valor bruto sem formatação extra / JSON cru)';
      }

      const propSchema: Record<string, unknown> = {
        type: paramType,
        description,
      };

      const rawEnum = cfg.enum || cfg.allowed_values || cfg.allowedValues;
      if (rawEnum) {
        const enumList = Array.isArray(rawEnum)
          ? rawEnum
          : String(rawEnum)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
        if (enumList.length) {
          propSchema.enum = enumList;
          propSchema.description += ` (Valores permitidos: ${enumList.join(', ')})`;
        }
      }

      properties[key] = propSchema;
      required.add(key);
    }

    const params = this.asRecord(tool.parameters);
    for (const [key, config] of Object.entries(params)) {
      const cfg = this.asRecord(config);
      if (cfg.source === 'null' || cfg.type === 'null') continue;
      if (cfg.source && cfg.source !== 'ai') continue;

      let paramType = 'string';
      let description =
        typeof cfg.value === 'string' && cfg.value.trim()
          ? cfg.value
          : `Parametro ${key} para executar a API.`;

      if (cfg.type === 'number' || cfg.type === 'stringDecimal') {
        paramType = 'string';
        description += ' (Valor numérico)';
      } else if (cfg.type === 'boolean') {
        paramType = 'boolean';
      }

      const propSchema: Record<string, unknown> = {
        type: paramType,
        description,
      };

      const rawEnum = cfg.enum || cfg.allowed_values || cfg.allowedValues;
      if (rawEnum) {
        const enumList = Array.isArray(rawEnum)
          ? rawEnum
          : String(rawEnum)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
        if (enumList.length) {
          propSchema.enum = enumList;
          propSchema.description += ` (Valores permitidos: ${enumList.join(', ')})`;
        }
      }

      properties[key] = propSchema;
      required.add(key);
    }

    return {
      type: 'object',
      properties,
      required: [...required],
      additionalProperties: false,
    };
  }

  private lookupSessionValue(
    state: Record<string, unknown> | undefined,
    path: string,
  ): unknown {
    if (!state || !path) return undefined;
    return path.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, state);
  }

  private extractUrlParams(url: string) {
    return [...url.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
  }

  private asRecord(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  private async loadMemory(conversationId: string): Promise<{
    source: 'redis' | 'database' | 'none';
    messages: MemoryMessage[];
  }> {
    const key = this.memoryKey(conversationId);
    const cached = await this.redisService.get<MemoryMessage[]>(key);
    if (cached?.length) {
      return { source: 'redis', messages: cached.slice(-this.memoryLimit) };
    }

    const messages = await this.prisma.messages.findMany({
      where: {
        conversation_id: conversationId,
        content: { not: null },
        sender_type: { in: ['customer', 'ai'] },
      },
      orderBy: { created_at: 'desc' },
      take: this.memoryLimit,
      select: { sender_type: true, content: true },
    });

    const history = messages
      .reverse()
      .map((item) => ({
        role: item.sender_type === 'ai' ? 'assistant' : 'user',
        content: item.content || '',
      }))
      .filter((item) => item.content) as MemoryMessage[];

    if (history.length) await this.saveMemory(conversationId, history);
    return {
      source: history.length ? 'database' : 'none',
      messages: history,
    };
  }

  private async saveMemory(conversationId: string, history: MemoryMessage[]) {
    await this.redisService.set(
      this.memoryKey(conversationId),
      history.filter((item) => item.content).slice(-this.memoryLimit),
    );
  }

  private memoryKey(conversationId: string) {
    return `memory:test-chat:${conversationId}`;
  }

  private async startTestAgentRun(params: {
    companyId: string;
    clientId: string;
    conversationId: string;
    inboundMessageId: string;
    agentId?: string;
    provider?: string;
    model?: string;
  }) {
    return this.prisma.agent_runs.create({
      data: {
        company_id: params.companyId,
        client_id: params.clientId,
        conversation_id: params.conversationId,
        inbound_message_id: params.inboundMessageId,
        agent_id: params.agentId || null,
        provider: params.provider || null,
        model: params.model || null,
        status: 'running',
        started_at: new Date(),
        trace: { source: 'enterprise_chat_test' } as any,
      },
    });
  }

  private async completeTestAgentRun(params: {
    agentRunId: string;
    responseMessageId?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    model?: string;
    provider?: string;
    startedAt?: Date | null;
  }) {
    const inputTokens = params.usage?.input_tokens ?? 0;
    const outputTokens = params.usage?.output_tokens ?? 0;
    const totalTokens =
      params.usage?.total_tokens ?? inputTokens + outputTokens;
    const cost = this.modelPricingService.calculateTokenCost({
      provider: params.provider,
      model: params.model,
      inputTokens,
      outputTokens,
    });

    const latencyMs = params.startedAt
      ? Date.now() - new Date(params.startedAt).getTime()
      : null;

    await this.prisma.agent_runs.update({
      where: { id: params.agentRunId },
      data: {
        response_message_id: params.responseMessageId || null,
        status: 'success',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost,
        latency_ms: latencyMs,
        completed_at: new Date(),
      },
    });
  }

  private async failTestAgentRun(
    agentRunId: string,
    error: unknown,
    startedAt?: Date | null,
  ) {
    const latencyMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : null;

    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        status: 'failed',
        error_message:
          error instanceof Error ? error.message : 'Erro ao executar agente',
        latency_ms: latencyMs,
        completed_at: new Date(),
      },
    });
  }

  private async saveMessage(params: {
    conversationId: string;
    companyId: string;
    clientId: string;
    senderType: string;
    direction: string;
    channel: string;
    content: string;
  }) {
    const message = await this.prisma.messages.create({
      data: {
        conversation_id: params.conversationId,
        company_id: params.companyId,
        sender_type: params.senderType,
        channel: params.channel,
        direction: params.direction,
        message_type: 'text',
        content: params.content,
        metadata: { source: 'enterprise_chat_test' },
        status: params.direction === 'inbound' ? 'received' : 'completed',
      },
      select: { id: true },
    });

    const now = new Date();
    await this.prisma.conversations.update({
      where: { id: params.conversationId },
      data: {
        last_message_at: now,
        ...(params.direction === 'inbound'
          ? { last_inbound_at: now }
          : { last_outbound_at: now }),
      },
    });

    return message;
  }

  private async executeApiTool(
    tool: ApiTool,
    args: Record<string, unknown>,
    sessionState?: Record<string, unknown>,
  ) {
    if (!tool.url) throw new Error(`Tool ${tool.name} sem URL configurada`);

    let url = tool.url;
    for (const param of this.extractUrlParams(url)) {
      const value = args[param] ?? this.lookupSessionValue(sessionState, param);
      if (value === undefined || value === null || value === '') {
        throw new Error(`Parametro obrigatorio ausente: ${param}`);
      }
      url = url.replace(`{${param}}`, encodeURIComponent(String(value)));
    }

    const method = (tool.method || 'GET').toUpperCase();
    const headers = this.asRecord(tool.headers);
    const init: RequestInit = { method, headers: headers as HeadersInit };
    const body = this.buildRequestBody(tool, args, sessionState);
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (
        !Object.keys(headers).some(
          (key) => key.toLowerCase() === 'content-type',
        )
      ) {
        (init.headers as Record<string, string>)['Content-Type'] =
          'application/json';
      }
    }

    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type') || '';
    const raw = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    const extracted = this.applyExtractData(raw, tool.extract_data);

    const result: {
      ok: boolean;
      status: number;
      data: any;
      raw: unknown;
      chained_result?: any;
    } = {
      ok: response.ok,
      status: response.status,
      data: extracted,
      raw,
    };

    if (!response.ok) {
      throw new Error(`Erro ao executar ${tool.name}: ${response.status}`);
    }

    // Suporte a API encadeada (next_api_id ou next_tool)
    const nextApiId =
      (headers.next_api_id as string) || (tool as any).next_tool;
    if (response.ok && nextApiId) {
      try {
        const nextApi = await this.prisma.painel_apis.findFirst({
          where: {
            OR: [{ id: nextApiId }, { name: nextApiId }],
            active: true,
          },
        });
        if (nextApi) {
          const nextTool = {
            id: nextApi.id,
            name: nextApi.name,
            functionName: this.toFunctionName(nextApi.name, nextApi.id),
            description: nextApi.description,
            method: nextApi.method,
            url: nextApi.url,
            headers: nextApi.headers,
            body: nextApi.body,
            parameters: nextApi.parameters,
            extract_data: nextApi.extract_data,
          };
          const nextArgs = {
            ...args,
            ...(typeof extracted === 'object' && extracted !== null
              ? extracted
              : {}),
            ...(typeof raw === 'object' && raw !== null
              ? (raw as Record<string, unknown>)
              : {}),
          };
          const nextResult = await this.executeApiTool(
            nextTool,
            nextArgs,
            sessionState,
          );
          if (nextResult && nextResult.ok) {
            result.data = {
              ...(typeof result.data === 'object' && result.data !== null
                ? result.data
                : {}),
              ...(typeof nextResult.data === 'object' &&
              nextResult.data !== null
                ? nextResult.data
                : {}),
              tem_ofertas: true,
            };
            result.chained_result = nextResult;
          }
        }
      } catch (chainErr) {
        this.logger.warn(
          `Falha ao executar API encadeada (${nextApiId}): ${chainErr instanceof Error ? chainErr.message : String(chainErr)}`,
        );
      }
    }

    return result;
  }

  private async executeNativeRagTool(
    args: Record<string, unknown>,
    message: string,
    context?: NativeRagRuntimeContext,
  ) {
    if (!context || !context.agentConfig) {
      return {
        error:
          'RAG search indisponivel: execute o chat com cliente, agente e sessao de teste persistida.',
      };
    }

    const nativeArgs = this.withFallbackQuery(args, message);
    const query = String(nativeArgs.query || '').trim();
    const limit = this.clampToolLimit(nativeArgs.limit);
    if (!query) return { error: 'Parametro query e obrigatorio.' };

    return this.ragSearchService.searchRag(
      context.agentConfig,
      query,
      context.clientId,
      limit,
      context.agentRunId || '',
      context.conversationId || '',
      context.messageId || '',
      context.companyId,
    );
  }

  private clampToolLimit(value: unknown) {
    const numeric = Number(value || 5);
    if (!Number.isFinite(numeric)) return 5;
    return Math.min(Math.max(Math.trunc(numeric), 1), 10);
  }

  private applyFieldFormatter(value: unknown, formatter?: string): unknown {
    if (value === null || value === undefined) return value;
    const str = String(value);

    switch (formatter) {
      case 'clean_digits':
        return str.replace(/\D/g, '');
      case 'date_iso': {
        const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (ddmmyyyy) {
          const day = ddmmyyyy[1].padStart(2, '0');
          const month = ddmmyyyy[2].padStart(2, '0');
          const year = ddmmyyyy[3];
          return `${year}-${month}-${day}`;
        }
        return str;
      }
      case 'uppercase':
        return str.toUpperCase();
      case 'lowercase':
        return str.toLowerCase();
      case 'trim':
        return str.trim();
      case 'reais_to_cents': {
        const num = Number(str.replace(',', '.').replace(/[^\d.]/g, ''));
        return isNaN(num) ? value : Math.round(num * 100);
      }
      case 'cents_to_reais': {
        const num = Number(str);
        return isNaN(num) ? value : Number((num / 100).toFixed(2));
      }
      default:
        return value;
    }
  }

  private applyExtractModifier(value: unknown, modifier?: string): unknown {
    if (value === null || value === undefined || value === '') return value;

    switch (modifier) {
      case 'currency_brl': {
        const num = Number(value);
        if (isNaN(num)) return value;
        return num.toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        });
      }
      case 'date_format_br': {
        const d = new Date(String(value));
        if (isNaN(d.getTime())) return value;
        return d.toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      case 'mask_cpf': {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length === 11) {
          return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        }
        return value;
      }
      case 'mask_cnpj': {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length === 14) {
          return digits.replace(
            /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
            '$1.$2.$3/$4-$5',
          );
        }
        return value;
      }
      case 'mask_phone': {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length === 11) {
          return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        }
        if (digits.length === 10) {
          return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
        }
        return value;
      }
      case 'uppercase':
        return String(value).toUpperCase();
      case 'lowercase':
        return String(value).toLowerCase();
      case 'trim':
        return String(value).trim();
      default:
        return value;
    }
  }

  private setDeepValue(target: any, path: string, value: unknown) {
    const parts = path.split('.');
    let current = target;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const nextPart = parts[i + 1];
      const isNextIndex = nextPart !== undefined && /^\d+$/.test(nextPart);

      if (isLast) {
        if (Array.isArray(current) && /^\d+$/.test(part)) {
          current[parseInt(part, 10)] = value;
        } else {
          current[part] = value;
        }
      } else {
        if (Array.isArray(current) && /^\d+$/.test(part)) {
          const idx = parseInt(part, 10);
          if (!current[idx] || typeof current[idx] !== 'object') {
            current[idx] = isNextIndex ? [] : {};
          }
          current = current[idx];
        } else {
          if (!current[part] || typeof current[part] !== 'object') {
            current[part] = isNextIndex ? [] : {};
          }
          current = current[part];
        }
      }
    }
  }

  private buildRequestBody(
    tool: ApiTool,
    args: Record<string, unknown>,
    sessionState?: Record<string, unknown>,
  ) {
    const body = this.asRecord(tool.body);
    if (!Object.keys(body).length) return undefined;

    const output: Record<string, unknown> = {};
    let isRootArray = false;

    for (const [key, config] of Object.entries(body)) {
      const cfg = this.asRecord(config);
      let resolvedValue: unknown = undefined;

      if (cfg.source === 'null' || cfg.type === 'null') {
        resolvedValue = null;
      } else if (cfg.source === 'ai') {
        resolvedValue = args[key];
        if (resolvedValue === undefined && key.includes('.')) {
          const leafKey = key.split('.').pop()!;
          if (args[leafKey] !== undefined) {
            resolvedValue = args[leafKey];
          }
        }
        if (resolvedValue === undefined) {
          resolvedValue = this.lookupSessionValue(sessionState, key);
        }
      } else if (cfg.source === 'system') {
        // "Dado de Outra API / Sessão": resolve na ordem estado da sessão ->
        // argumentos da IA. Se nada for encontrado, o campo é OMITIDO
        // (nunca enviar o nome da variável literal como valor).
        const varName =
          typeof cfg.value === 'string'
            ? cfg.value.replace(/[{}]/g, '').trim()
            : '';
        const isCpfField =
          varName.toLowerCase().includes('cpf') ||
          key.toLowerCase().includes('cpf');
        resolvedValue =
          this.lookupSessionValue(sessionState, varName) ??
          this.lookupSessionValue(sessionState, key) ??
          (isCpfField
            ? this.lookupSessionValue(sessionState, 'cliente_cpf')
            : undefined) ??
          (args as any)[varName] ??
          (args as any)[key] ??
          (args as any)['cliente_cpf'] ??
          (args as any)['cpf'];
      } else if ('value' in cfg) {
        const rawVal = cfg.value;
        if (
          typeof rawVal === 'string' &&
          rawVal.startsWith('{{') &&
          rawVal.endsWith('}}')
        ) {
          const varName = rawVal.replace(/[{}]/g, '').trim();
          resolvedValue =
            (args as any)[varName] ??
            (args as any)[key] ??
            this.lookupSessionValue(sessionState, varName) ??
            rawVal;
        } else {
          resolvedValue = rawVal;
        }
      } else {
        resolvedValue = config;
      }

      // Aplica formatador pré-envio se configurado
      if (cfg.formatter) {
        resolvedValue = this.applyFieldFormatter(
          resolvedValue,
          String(cfg.formatter),
        );
      }

      // Tratamento especial de tipos
      if (cfg.type === 'null' || resolvedValue === 'null') {
        resolvedValue = null;
      } else if (
        cfg.type === 'raw' ||
        cfg.type === 'json' ||
        cfg.type === 'unparsed'
      ) {
        if (typeof resolvedValue === 'string') {
          const trimmed = resolvedValue.trim();
          if (
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))
          ) {
            try {
              resolvedValue = JSON.parse(trimmed);
            } catch {
              // Mantém valor raw original se não for JSON parseable
            }
          }
        }
      } else if (cfg.type === 'number') {
        if (
          resolvedValue !== null &&
          resolvedValue !== undefined &&
          resolvedValue !== ''
        ) {
          const num = Number(resolvedValue);
          if (!isNaN(num)) resolvedValue = num;
        }
      } else if (cfg.type === 'boolean') {
        resolvedValue =
          resolvedValue === true ||
          resolvedValue === 'true' ||
          resolvedValue === 1 ||
          resolvedValue === '1';
      } else if (cfg.type === 'stringDecimal') {
        if (typeof resolvedValue === 'number') {
          resolvedValue = resolvedValue.toFixed(2);
        } else if (resolvedValue !== null && resolvedValue !== undefined) {
          resolvedValue = String(resolvedValue);
        }
      }

      if (key.startsWith('0.') || key === '0') {
        isRootArray = true;
      }

      if (key.includes('.')) {
        this.setDeepValue(output, key, resolvedValue);
      } else {
        output[key] = resolvedValue;
      }
    }

    if (isRootArray && output['0'] && typeof output['0'] === 'object') {
      return [output['0']];
    }

    return output;
  }

  private applyExtractData(raw: unknown, extractData: unknown) {
    const map = this.asRecord(extractData);
    if (!Object.keys(map).length || typeof raw !== 'object' || raw === null) {
      return raw;
    }

    const output: Record<string, unknown> = {};
    for (const [key, config] of Object.entries(map)) {
      if (typeof config === 'string') {
        output[key] = this.getByPath(raw as Record<string, unknown>, config);
      } else if (
        typeof config === 'object' &&
        config !== null &&
        'path' in config
      ) {
        const cfg = config as {
          path?: string;
          modifier?: string;
          fallback?: string;
          max_items?: number;
          rules?: Array<{
            operator: string;
            compare_value: string;
            return_value: string;
          }>;
        };
        let value = this.getByPath(
          raw as Record<string, unknown>,
          cfg.path || '',
        );

        if (Array.isArray(value) && cfg.max_items && cfg.max_items > 0) {
          value = value.slice(0, cfg.max_items);
        }

        if (cfg.rules?.length) {
          value = this.evaluateComparisonRules(value, cfg.rules);
        }

        if (cfg.modifier) {
          value = this.applyExtractModifier(value, cfg.modifier);
        }

        if (
          (value === null || value === undefined || value === '') &&
          cfg.fallback !== undefined
        ) {
          value = cfg.fallback;
        }

        output[key] = value;
      } else {
        output[key] = config;
      }
    }
    return output;
  }

  private evaluateComparisonRules(
    value: unknown,
    rules: Array<{
      operator: string;
      compare_value: string;
      return_value: string;
    }>,
  ): unknown {
    if (!rules || !rules.length) return value;

    for (const rule of rules) {
      const { operator, compare_value, return_value } = rule;

      if (operator === 'is_empty_array') {
        if (Array.isArray(value) && value.length === 0) return return_value;
        continue;
      }
      if (operator === 'is_not_empty_array') {
        if (Array.isArray(value) && value.length > 0) return return_value;
        continue;
      }
      if (operator === 'is_empty') {
        if (
          value === null ||
          value === undefined ||
          value === '' ||
          (Array.isArray(value) && value.length === 0) ||
          (typeof value === 'object' &&
            Object.keys(value as object).length === 0)
        ) {
          return return_value;
        }
        continue;
      }
      if (operator === 'is_not_empty') {
        if (
          value !== null &&
          value !== undefined &&
          value !== '' &&
          (!Array.isArray(value) || value.length > 0)
        ) {
          return return_value;
        }
        continue;
      }

      if (value === null || value === undefined) continue;

      if (
        operator === '==' &&
        Array.isArray(value) &&
        (compare_value === '[]' || compare_value === '')
      ) {
        if (value.length === 0) return return_value;
        continue;
      }
      if (
        operator === '!=' &&
        Array.isArray(value) &&
        (compare_value === '[]' || compare_value === '')
      ) {
        if (value.length > 0) return return_value;
        continue;
      }

      const numVal = Number(value);
      const numRule = Number(compare_value);
      const shouldCompareAsNumber =
        !isNaN(numVal) &&
        !isNaN(numRule) &&
        String(compare_value).trim() !== '';
      const valToCompare: string | number = shouldCompareAsNumber
        ? numVal
        : String(value).trim();
      const ruleVal: string | number = shouldCompareAsNumber
        ? numRule
        : String(compare_value).trim();

      const isMatch = (() => {
        switch (operator) {
          case '==':
            return valToCompare == ruleVal;
          case '!=':
            return valToCompare != ruleVal;
          case '>=':
            return Number(valToCompare) >= Number(ruleVal);
          case '<=':
            return Number(valToCompare) <= Number(ruleVal);
          case '>':
            return Number(valToCompare) > Number(ruleVal);
          case '<':
            return Number(valToCompare) < Number(ruleVal);
          case 'includes':
            if (Array.isArray(value)) {
              return value.includes(compare_value);
            }
            return String(valToCompare).includes(String(ruleVal));
          default:
            return false;
        }
      })();

      if (isMatch) {
        return return_value;
      }
    }

    return value;
  }

  private getByPath(value: unknown, path: string): unknown {
    if (!path || value == null) return null;

    const res = this.resolveByPathDirect(value, path);
    if (res !== null && res !== undefined) return res;

    // Fallback: se o objeto possui encapsulamento .data (comum em n8n e APIs REST)
    if (
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      !path.startsWith('data.')
    ) {
      const dataRes = this.resolveByPathDirect((value as any).data, path);
      if (dataRes !== null && dataRes !== undefined) return dataRes;
    }

    return null;
  }

  private resolveByPathDirect(value: unknown, path: string): unknown {
    if (!path || value == null) return null;

    const steps: { key: string; index: string | null }[] = [];
    const regex = /([^\].[]+)(?:\[([^\]]+)])?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(path)) !== null) {
      steps.push({
        key: match[1].trim(),
        index: match[2] !== undefined ? match[2].trim() : null,
      });
    }

    let current: any = value;
    for (let i = 0; i < steps.length; i++) {
      if (current == null) return null;
      const { key, index } = steps[i];

      current = current[key];

      if (index !== null) {
        if (current == null) return null;

        if (index === '*') {
          if (Array.isArray(current)) {
            const remainingPath = steps
              .slice(i + 1)
              .map((s) => s.key + (s.index !== null ? `[${s.index}]` : ''))
              .join('.');

            if (remainingPath) {
              current = current
                .map((item: any) => this.getByPath(item, remainingPath))
                .filter((v: any) => v !== null && v !== undefined);
            }
          } else {
            return null;
          }
        } else {
          const idx = parseInt(index);
          if (Array.isArray(current)) {
            current = isNaN(idx) ? current[current.length - 1] : current[idx];
          } else {
            return null;
          }
        }
      }
    }

    return current;
  }

  private async transcribeAudioBuffer(
    dataBase64: string,
    mimeType: string,
    apiKey: string,
  ): Promise<string> {
    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const ext = mimeType.includes('mp4')
        ? 'mp4'
        : mimeType.includes('wav')
          ? 'wav'
          : mimeType.includes('ogg')
            ? 'ogg'
            : mimeType.includes('mpeg') || mimeType.includes('mp3')
              ? 'mp3'
              : 'webm';

      const blob = new Blob([buffer], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', 'whisper-large-v3');

      const res = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        },
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, detail: await res.text() },
          'Falha na transcrição de áudio via Groq',
        );
        return '[Áudio enviado pelo usuário]';
      }
      const json = (await res.json()) as { text?: string };
      return json.text || '[Áudio sem fala detectada]';
    } catch {
      return '[Áudio recebido]';
    }
  }

  private async callGemini(
    message: string,
    model: string,
    apiKey: string,
    files?: { mimeType: string; data: string }[],
    systemPrompt?: string,
    history: MemoryMessage[] = [],
  ): Promise<{
    text: string;
    transcription?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }> {
    const imageFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('image/'),
    );
    const audioFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('audio/'),
    );

    const userPromptText =
      message && message.trim() && message !== 'Descreva o arquivo anexado.'
        ? message
        : imageFiles.length > 0
          ? 'O usuário enviou a(s) imagem(ns)/documento(s) anexado(s) para dar andamento ao atendimento. Utilize as informações, dados e textos contidos na imagem como contexto fornecido pelo cliente e dê continuidade ao fluxo de atendimento normalmente, sem apenas descrever a imagem.'
          : audioFiles.length > 0
            ? 'O usuário enviou uma mensagem de áudio. Ouça a transcrição e responda ao cliente adequadamente.'
            : '';

    const parts: any[] = [{ text: userPromptText }];

    if (files?.length) {
      for (const file of files) {
        parts.push({
          inlineData: { mimeType: file.mimeType, data: file.data },
        });
      }
    }

    const contents: any[] = [];
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Entendido.' }] });
    }
    for (const item of history) {
      contents.push({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.content }],
      });
    }
    contents.push({ role: 'user', parts });

    let transcription: string | undefined;
    if (audioFiles.length > 0) {
      try {
        const transList: string[] = [];
        for (const af of audioFiles) {
          const transPrompt =
            'Transcreva o áudio a seguir com fidelidade. Retorne estritamente o texto transcrito, sem introduções ou observações.';
          const transRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',
                    parts: [
                      { text: transPrompt },
                      { inlineData: { mimeType: af.mimeType, data: af.data } },
                    ],
                  },
                ],
              }),
            },
          );
          if (transRes.ok) {
            const transJson = (await transRes.json()) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
              }>;
            };
            const transText =
              transJson?.candidates?.[0]?.content?.parts
                ?.map((p) => p.text)
                .join('')
                .trim() || '';
            if (transText) transList.push(transText);
          }
        }
        if (transList.length > 0) {
          transcription = transList.join('\n');
        }
      } catch {}
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      },
    );
    if (!res.ok)
      throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const promptTokens = json?.usageMetadata?.promptTokenCount || 0;
    const candidatesTokens = json?.usageMetadata?.candidatesTokenCount || 0;

    return {
      text:
        json?.candidates?.[0]?.content?.parts
          ?.map((part: any) => part.text)
          .join('') || 'Sem resposta',
      transcription,
      usage: {
        input_tokens: promptTokens,
        output_tokens: candidatesTokens,
        total_tokens: promptTokens + candidatesTokens,
      },
    };
  }

  private async describeImageForChat(
    file: { mimeType: string; data: string },
    provider: string,
    apiKey: string,
    clientId?: string,
  ): Promise<string> {
    const prompt =
      'Transcreva todo o texto visível, números, códigos, campos, tabelas e descreva os detalhes e dados relevantes desta imagem em português de forma concisa e factual, para servir estritamente de dados de contexto para um assistente de IA.';

    // 1. Tenta usar Gemini primeiro (ideal e super rápido para OCR/Visão)
    let geminiApiKey: string | undefined;
    if (clientId) {
      try {
        geminiApiKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          'gemini',
        );
      } catch {}
    }
    if (!geminiApiKey) {
      geminiApiKey = process.env.GEMINI_API_KEY;
    }

    if (geminiApiKey) {
      const geminiModel =
        process.env.MEDIA_VISION_MODEL || 'gemini-2.5-flash-lite';
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: file.mimeType,
                        data: file.data,
                      },
                    },
                  ],
                },
              ],
            }),
          },
        );
        if (res.ok) {
          const json = await res.json();
          const text =
            json?.candidates?.[0]?.content?.parts
              ?.map((p: any) => p.text)
              .join('')
              .trim() || '';
          if (text) return text;
        } else {
          this.logger.warn(
            { status: res.status, detail: await res.text() },
            'Falha na resposta do Gemini Vision',
          );
        }
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          'Falha na visão via Gemini, tentando fallback',
        );
      }
    }

    // 2. Tenta usar OpenRouter se configurado
    let openRouterKey: string | undefined;
    if (provider.toLowerCase() === 'openrouter') {
      openRouterKey = apiKey;
    } else if (clientId) {
      try {
        openRouterKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          'openrouter',
        );
      } catch {}
    }
    if (!openRouterKey) {
      openRouterKey = process.env.OPENROUTER_API_KEY;
    }

    if (openRouterKey) {
      const model = process.env.MEDIA_VISION_MODEL || 'google/gemini-2.5-flash';
      try {
        const response = await fetch(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openRouterKey}`,
            },
            body: JSON.stringify({
              model,
              max_tokens: 1000,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:${file.mimeType};base64,${file.data}`,
                      },
                    },
                  ],
                },
              ],
            }),
          },
        );

        if (response.ok) {
          const json = (await response.json()) as {
            choices?: Array<{ message?: { content?: string | unknown[] } }>;
          };
          const content = json.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.trim())
            return content.trim();
          if (Array.isArray(content)) {
            const text = content
              .map((part: any) =>
                typeof part?.text === 'string' ? part.text : '',
              )
              .join('')
              .trim();
            if (text) return text;
          }
        }
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          'Falha na visão via OpenRouter',
        );
      }
    }

    throw new Error(
      'Visão/OCR indisponível: Groq não possui modelos de visão ativos. Por favor, configure uma chave do Google Gemini em Configurações > Provedores para processamento de imagens e documentos.',
    );
  }

  private async callOpenAICompatible(
    baseUrl: string,
    message: string,
    model: string,
    apiKey: string,
    files?: { mimeType: string; data: string }[],
    systemPrompt?: string,
    history: MemoryMessage[] = [],
    apiTools: ApiTool[] = [],
    toolCalls: ToolCallDebug[] = [],
    nativeRagContext?: NativeRagRuntimeContext,
  ): Promise<{
    text: string;
    toolCalls?: ToolCallDebug[];
    transcription?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }> {
    const provider = baseUrl.includes('groq')
      ? 'groq'
      : baseUrl.includes('google')
        ? 'gemini'
        : 'openrouter';
    const openAiTools = this.buildOpenAiTools(apiTools);
    const toolsByFunctionName = new Map(
      apiTools.map((tool) => [tool.functionName, tool]),
    );

    const toolInstruction =
      openAiTools.length > 0
        ? '\n\n[INSTRUÇÃO DE FERRAMENTAS]: Ao chamar ferramentas, certifique-se de que todos os parâmetros do tipo string (como CEP, CPF, telefones, códigos ou identificadores numéricos) sejam SEMPRE passados entre aspas como strings (ex: "81450718"), NUNCA como número sem aspas.'
        : '';

    const messages: any[] = [];
    const finalSystemPrompt = `${systemPrompt || ''}${toolInstruction}`.trim();
    if (finalSystemPrompt) {
      messages.push({ role: 'system', content: finalSystemPrompt });
    }
    for (const item of history) {
      messages.push({ role: item.role, content: item.content });
    }

    const imageFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('image/'),
    );
    const audioFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('audio/'),
    );

    let userText = message;
    let transcription: string | undefined;
    if (audioFiles.length > 0) {
      const transcriptions: string[] = [];
      const transcriptionKey =
        provider.toLowerCase() === 'groq'
          ? apiKey
          : nativeRagContext
            ? await this.providerKeyResolver.resolveApiKey(
                nativeRagContext.clientId,
                'groq',
              )
            : apiKey;
      for (const audioFile of audioFiles) {
        const transcript = await this.transcribeAudioBuffer(
          audioFile.data,
          audioFile.mimeType,
          transcriptionKey,
        );
        transcriptions.push(transcript);
      }
      transcription = transcriptions.join('\n');
      userText = `${userText}\n\n<transcricao_audio>\n${transcription}\n</transcricao_audio>`;
    }

    if (imageFiles.length > 0) {
      const descriptions: string[] = [];
      for (const imageFile of imageFiles) {
        descriptions.push(
          await this.describeImageForChat(
            imageFile,
            provider,
            apiKey,
            nativeRagContext?.clientId,
          ),
        );
      }
      const imageContext = descriptions
        .map(
          (description) =>
            `<transcricao_imagem>\n${description}\n</transcricao_imagem>`,
        )
        .join('\n\n');

      const userInstruction =
        message && message.trim() && message !== 'Descreva o arquivo anexado.'
          ? message
          : 'O usuário enviou uma imagem/documento anexado. Considere as informações transcritas na tag <transcricao_imagem> acima como dados e contexto fornecidos pelo usuário e dê andamento ao fluxo de atendimento normalmente, sem apenas descrever a imagem.';

      userText = `${imageContext}\n\n${userInstruction}`;
    }
    messages.push({ role: 'user', content: userText });
    let responseMessage: any = null;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let currentTools = openAiTools.length ? [...openAiTools] : [];

    for (let loop = 0; loop < 8; loop++) {
      const payload: Record<string, unknown> = {
        model,
        messages,
        max_tokens: 4096,
      };
      if (currentTools.length) {
        payload.tools = currentTools;
        payload.tool_choice = 'auto';
      }

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (
        baseUrl.includes('google') ||
        baseUrl.includes('generativelanguage')
      ) {
        requestHeaders['x-goog-api-key'] = apiKey;
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });
      if (!res.ok)
        throw new Error(`${baseUrl} error ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if (json?.usage) {
        totalInputTokens += json.usage.prompt_tokens || 0;
        totalOutputTokens += json.usage.completion_tokens || 0;
      }
      responseMessage = json?.choices?.[0]?.message;
      if (!responseMessage) break;

      const finishReason = json?.choices?.[0]?.finish_reason;
      const rawContent = responseMessage?.content;
      const contentText =
        typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent
                .map((part: any) =>
                  typeof part?.text === 'string' ? part.text : '',
                )
                .join('')
            : '';
      if (!contentText.trim() && !responseMessage?.tool_calls?.length) {
        this.logger.warn(
          { provider, model, finishReason, loop },
          'chat/completions retornou resposta sem conteúdo textual',
        );
      }
      responseMessage = { ...responseMessage, content: contentText };

      messages.push(responseMessage);
      const calls = responseMessage.tool_calls || [];
      if (!calls.length) break;

      for (const call of calls) {
        const functionName = call?.function?.name;
        const tool = toolsByFunctionName.get(functionName);
        const args = this.parseToolArguments(call?.function?.arguments);

        const isNativeWeb =
          functionName === this.webSearchService.getNativeToolId();
        const isNativeRag = functionName === RAG_SEARCH_TOOL_ID;
        const isNativeHandoff =
          functionName === 'transfer_to_human' ||
          functionName === 'request_handoff';

        const isSubagent = functionName.startsWith('subagent_');

        if (
          !tool &&
          !isNativeWeb &&
          !isNativeRag &&
          !isNativeHandoff &&
          !isSubagent
        ) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: `Tool ${functionName} nao encontrada`,
            }),
          });
          continue;
        }

        try {
          let result;
          if (isNativeWeb) {
            const nativeArgs = this.withFallbackQuery(args, message);
            result = await this.webSearchService.execute(nativeArgs);
            toolCalls.push({
              name: 'web_search',
              arguments: nativeArgs,
              result,
            });
          } else if (isNativeRag) {
            const nativeArgs = this.withFallbackQuery(args, message);
            result = await this.executeNativeRagTool(
              nativeArgs,
              message,
              nativeRagContext,
            );
            toolCalls.push({
              name: 'rag.search',
              arguments: {
                ...nativeArgs,
                limit: this.clampToolLimit(nativeArgs.limit),
              },
              result,
            });
          } else if (isNativeHandoff) {
            const convId = nativeRagContext?.conversationId;
            if (convId) {
              await this.conversationsService.requestHandoff(convId, {
                reason: String(args.reason || 'solicitação no chat'),
                requested_by: 'ai_tool',
              });
            }
            result = {
              status: 'transferred',
              message:
                'Atendimento transferido para a equipe de atendentes humanos com sucesso. Avise o cliente cordialmente que um operador irá atendê-lo a seguir.',
            };
            toolCalls.push({
              name: 'transfer_to_human',
              arguments: args,
              result,
            });
          } else if (isSubagent) {
            result = await this.executeSubagentTool(
              functionName,
              args,
              nativeRagContext?.clientId || '',
              nativeRagContext?.companyId || '',
              nativeRagContext?.conversationId,
            );
            toolCalls.push({
              name: functionName,
              arguments: args,
              result,
            });
          } else if (tool) {
            const sessionState = nativeRagContext?.conversationId
              ? await this.loadState(nativeRagContext.conversationId)
              : {};
            result = await this.executeApiTool(tool, args, sessionState);
            toolCalls.push({ name: tool.name, arguments: args, result });
          } else {
            result = { error: `Tool ${functionName} nao encontrada` };
            toolCalls.push({ name: functionName, arguments: args, result });
          }

          const hasFailure = Boolean(result?.error || result?.ok === false);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });

          if (hasFailure) {
            this.logger.warn(
              `⛔ [Fail-Fast] Tool ${tool?.name || functionName} falhou. Interrompendo cadeia de execução.`,
            );
            // Responde chamadas pendentes no mesmo batch como canceladas
            const remainingCalls = calls.slice(calls.indexOf(call) + 1);
            for (const remaining of remainingCalls) {
              messages.push({
                role: 'tool',
                tool_call_id: remaining.id,
                content: JSON.stringify({
                  error:
                    'Execução cancelada: a tool anterior falhou (Fail-Fast).',
                }),
              });
            }
            // Remove tools nas iterações seguintes para forçar resposta de texto imediata
            currentTools = [];
            break;
          }
        } catch (error) {
          const toolName = tool?.name || functionName;
          const result = {
            error:
              error instanceof Error ? error.message : 'Erro ao executar tool',
          };
          toolCalls.push({ name: toolName, arguments: args, result });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });

          this.logger.warn(
            `⛔ [Fail-Fast] Tool ${toolName} lançou erro. Interrompendo cadeia de execução.`,
          );
          const remainingCalls = calls.slice(calls.indexOf(call) + 1);
          for (const remaining of remainingCalls) {
            messages.push({
              role: 'tool',
              tool_call_id: remaining.id,
              content: JSON.stringify({
                error:
                  'Execução cancelada: a tool anterior falhou (Fail-Fast).',
              }),
            });
          }
          currentTools = [];
          break;
        }
      }
    }

    let finalText = responseMessage?.content || '';
    if (typeof finalText !== 'string') finalText = String(finalText ?? '');

    // Se o modelo encerrou sem conteúdo textual (ex: após cadeia de tool calls
    // como switch_agent), faz uma chamada final sem ferramentas para forçar texto
    if (!finalText.trim() && messages.length > 0) {
      try {
        const retryRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  'Use as informações das ferramentas executadas acima e responda ao usuário em texto de forma clara e objetiva.',
              },
            ],
            max_tokens: 4096,
          }),
        });
        if (retryRes.ok) {
          const retryJson = await retryRes.json();
          if (retryJson?.usage) {
            totalInputTokens += retryJson.usage.prompt_tokens || 0;
            totalOutputTokens += retryJson.usage.completion_tokens || 0;
          }
          const retryContent = retryJson?.choices?.[0]?.message?.content;
          if (typeof retryContent === 'string' && retryContent.trim()) {
            finalText = retryContent.trim();
          }
        }
      } catch (retryErr) {
        this.logger.warn(
          { error: (retryErr as Error).message },
          'Falha no retry de resposta textual após tool calls',
        );
      }
    }

    return {
      text: finalText || 'Sem resposta',
      toolCalls,
      transcription,
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
      },
    };
  }

  private parseToolArguments(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string') return {};
    try {
      const parsed = JSON.parse(raw);
      return this.asRecord(parsed);
    } catch {
      return {};
    }
  }

  private withFallbackQuery(
    args: Record<string, unknown>,
    message: string,
  ): Record<string, unknown> {
    if (typeof args.query === 'string' && args.query.trim()) return args;
    if (typeof args.question === 'string' && args.question.trim()) return args;
    if (typeof args.pergunta === 'string' && args.pergunta.trim()) return args;
    return { ...args, query: message };
  }

  private async listGeminiModels(apiKey: string): Promise<string[]> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    );
    if (!res.ok)
      throw new Error(`Erro ao listar modelos Gemini: ${res.status}`);
    const json = await res.json();
    return (json.models || [])
      .filter((model: any) =>
        model.supportedGenerationMethods?.includes('generateContent'),
      )
      .map((model: any) => model.name.replace('models/', ''))
      .sort();
  }

  private async listGroqModels(apiKey: string): Promise<string[]> {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Erro ao listar modelos Groq: ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .filter((model: any) => model.active)
      .map((model: any) => model.id)
      .sort();
  }

  private async listOpenRouterModels(apiKey: string): Promise<string[]> {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok)
      throw new Error(`Erro ao listar modelos OpenRouter: ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .filter((model: any) => model.id)
      .map((model: any) => model.id)
      .sort();
  }

  private async syncPainelInteraction(params: {
    companyId: string;
    clientId: string;
    agentId?: string;
    agentName?: string;
    sessionId: string;
    channel: string;
    userMessage?: string;
    assistantMessage?: string;
    contextVariables?: Record<string, any>;
    toolCalls?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    provider?: string;
    model?: string;
  }) {
    try {
      const vars = params.contextVariables || {};
      const isRightParty = !!(
        vars.cliente_cpf ||
        vars.cpf ||
        vars.cliente_nome
      );
      const debtAmount = vars.valor_divida ? Number(vars.valor_divida) : null;
      const isDebtPresented = debtAmount !== null && debtAmount > 0;
      const isAgreementReached = !!(vars.acordo_confirmado || vars.acordo_id);
      const isPromiseToPay = !!(vars.promessa_pagamento || vars.data_promessa);

      let disposition = 'IN_PROGRESS';
      if (isAgreementReached) disposition = 'AGREEMENT_CLOSED';
      else if (isPromiseToPay) disposition = 'PTP';
      else if (isDebtPresented) disposition = 'DEBT_PRESENTED';
      else if (isRightParty) disposition = 'RPC_NO_DEAL';
      else if (params.userMessage) disposition = 'HUMAN_ANSWERED';

      const existing = await this.prisma.painel_interactions.findUnique({
        where: { session_id: params.sessionId },
      });

      const currentMessages = Array.isArray(existing?.messages)
        ? (existing.messages as any[])
        : [];

      const newMsgs = [...currentMessages];
      const now = new Date();

      if (params.userMessage) {
        newMsgs.push({
          id: `msg_u_${Date.now()}`,
          role: 'user',
          content: params.userMessage,
          timestamp: now.toISOString(),
        });
      }

      if (params.assistantMessage) {
        newMsgs.push({
          id: `msg_a_${Date.now()}`,
          role: 'assistant',
          content: params.assistantMessage,
          tool_calls: params.toolCalls || [],
          timestamp: new Date(now.getTime() + 100).toISOString(),
        });
      }

      const totalTokens =
        (existing?.total_tokens || 0) + (params.usage?.total_tokens || 0);
      const promptTokens =
        (existing?.prompt_tokens || 0) + (params.usage?.input_tokens || 0);
      const completionTokens =
        (existing?.completion_tokens || 0) + (params.usage?.output_tokens || 0);

      const clientIdentifier =
        (vars.cliente_cpf as string) ||
        (vars.cpf as string) ||
        existing?.client_identifier ||
        null;
      const clientName =
        (vars.cliente_nome as string) || existing?.client_name || null;

      await this.prisma.painel_interactions.upsert({
        where: { session_id: params.sessionId },
        create: {
          company_id: params.companyId,
          client_id: params.clientId,
          agent_id: params.agentId,
          agent_name: params.agentName,
          session_id: params.sessionId,
          channel: params.channel || 'webchat',
          direction: 'inbound',
          interaction_mode: 'both',
          client_identifier: clientIdentifier,
          client_name: clientName,
          has_human_answer: true,
          human_answered_at: existing?.human_answered_at || now,
          is_right_party: isRightParty,
          right_party_at: isRightParty ? existing?.right_party_at || now : null,
          is_debt_presented: isDebtPresented,
          debt_presented_at: isDebtPresented
            ? existing?.debt_presented_at || now
            : null,
          debt_amount: debtAmount !== null ? (debtAmount as any) : null,
          is_agreement_reached: isAgreementReached,
          agreement_at: isAgreementReached
            ? existing?.agreement_at || now
            : null,
          agreement_id: (vars.acordo_id as string) || null,
          agreement_amount: vars.valor_total
            ? Number(vars.valor_total)
            : debtAmount !== null
              ? (debtAmount as any)
              : null,
          is_promise_to_pay: isPromiseToPay,
          promise_to_pay_at: isPromiseToPay
            ? existing?.promise_to_pay_at || now
            : null,
          disposition,
          service_step: vars.service_step || null,
          llm_provider: params.provider,
          llm_model: params.model,
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          context_variables: vars as any,
          messages: newMsgs as any,
          started_at: existing?.started_at || now,
          status: isAgreementReached ? 'completed' : 'ongoing',
        },
        update: {
          agent_id: params.agentId || existing?.agent_id,
          agent_name: params.agentName || existing?.agent_name,
          client_identifier: clientIdentifier || existing?.client_identifier,
          client_name: clientName || existing?.client_name,
          has_human_answer: true,
          is_right_party: isRightParty || existing?.is_right_party || false,
          right_party_at: isRightParty
            ? existing?.right_party_at || now
            : existing?.right_party_at,
          is_debt_presented:
            isDebtPresented || existing?.is_debt_presented || false,
          debt_presented_at: isDebtPresented
            ? existing?.debt_presented_at || now
            : existing?.debt_presented_at,
          debt_amount:
            debtAmount !== null ? (debtAmount as any) : existing?.debt_amount,
          is_agreement_reached:
            isAgreementReached || existing?.is_agreement_reached || false,
          agreement_at: isAgreementReached
            ? existing?.agreement_at || now
            : existing?.agreement_at,
          agreement_id:
            (vars.acordo_id as string) || existing?.agreement_id || null,
          is_promise_to_pay:
            isPromiseToPay || existing?.is_promise_to_pay || false,
          promise_to_pay_at: isPromiseToPay
            ? existing?.promise_to_pay_at || now
            : existing?.promise_to_pay_at,
          disposition,
          llm_provider: params.provider || existing?.llm_provider,
          llm_model: params.model || existing?.llm_model,
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          context_variables: vars as any,
          messages: newMsgs as any,
          status: isAgreementReached
            ? 'completed'
            : existing?.status || 'ongoing',
          ended_at: isAgreementReached ? now : existing?.ended_at,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao sincronizar painel_interactions no test-chat: ${err}`,
      );
    }
  }
}
