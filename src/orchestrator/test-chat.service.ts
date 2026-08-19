import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import type { ClearTestChatDto, TestChatDto } from './dto/test-chat.dto';
import {
  evaluateConditions,
  type ActivationConditionGroup,
} from './utils/condition-evaluator.util';
import { WebSearchService } from '../agents/web-search/web-search.service';
import { RagSearchService } from './services/rag-search.service';
import {
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type AgentConfig,
} from './types/capabilities.types';

interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const TEST_CHAT_CONTEXT_KEY = 'test_chat_context_variables';
const RAG_SEARCH_TOOL_ID = 'rag_search';

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
}

type ToolCallDebug = TestChatDebug['toolCalls'][number];

interface NativeRagRuntimeContext {
  agentConfig: AgentConfig;
  clientId: string;
  companyId: string;
  conversationId: string;
  messageId: string;
  agentRunId: string;
}

import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { ModelPricingService } from './services/model-pricing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MediaService } from '../media/media.service';

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
  ) {}

  async listModels(
    provider: string,
    apiKey?: string,
    clientId?: string,
  ): Promise<string[]> {
    let finalKey = apiKey?.trim() || '';

    // Se a chave for vazia ou for uma máscara (ex: 'AIza...1234' ou '***'), resolve do banco/env
    if (
      (!finalKey || finalKey.includes('...') || finalKey === '********') &&
      clientId
    ) {
      finalKey = await this.providerKeyResolver.resolveApiKey(
        clientId,
        provider,
      );
    }

    if (!finalKey) {
      finalKey = await this.providerKeyResolver.resolveApiKey(
        'default',
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
    let {
      message,
      provider,
      model,
      apiKey,
      files,
      systemPrompt,
      clientId,
      agentId,
    } = dto;
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
      contextVariables = this.sanitizeContextVariables(metadata);
      contextVariables.nome_agente = client.agent_name || '';

      if (!resolvedAgentId) {
        const initialAgent = await this.prisma.painel_agents.findFirst({
          where: { client_id: clientId, is_initial: true, is_active: true },
        });
        if (initialAgent) {
          resolvedAgentId = initialAgent.id;
        } else {
          const firstAgent = await this.prisma.painel_agents.findFirst({
            where: { client_id: clientId, is_active: true },
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

        const state = await this.loadState(conversationId);
        resolvedAgentId = await this.resolveAgentId(
          clientId,
          state,
          resolvedAgentId || '',
          persistedContext,
        );
      }

      let agent: any = null;
      if (resolvedAgentId) {
        agent = await this.prisma.painel_agents.findUnique({
          where: { id: resolvedAgentId },
        });
      }

      if (agent) {
        resolvedAgentName = agent.service_step || agent.id;
        resolvedAgentConfig = this.buildAgentConfigFromRecord(agent);

        const transitions = agent.transitions || {};
        provider = transitions.llm_provider || provider;
        model = agent.model || model;
        systemPrompt = systemPrompt || agent.system_prompt || undefined;
        availableTools = Array.isArray(agent.allowed_tool_names)
          ? agent.allowed_tool_names.filter(
              (tool: unknown): tool is string => typeof tool === 'string',
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
        apiTools.push(this.buildNativeHandoffApiTool());

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

      if (!apiKey && provider) {
        apiKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          provider,
        );
      }
    }

    if (!provider || !model || !apiKey) {
      throw new Error(
        'Configuracao incompleta: provider, model e apiKey sao obrigatorios',
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
    const acquired = await this.redisService.acquireLock(lockKey, 120);
    if (!acquired) {
      throw new Error(
        'Conversa em processamento. Tente novamente em instantes.',
      );
    }

    try {
      const memory = await this.loadMemory(conversationId);
      const history = memory.messages;
      const inboundMessage = await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'customer',
        direction: 'inbound',
        channel: originChannel,
        content: message,
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
        : message;

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

      if (resolvedAgentId && clientId && companyId) {
        const immediateAgent = await this.checkImmediateActivation(
          clientId,
          resolvedAgentId,
          contextVariables,
        );
        if (immediateAgent) {
          const immediateResult = await this.processWithAgent(
            immediateAgent,
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
              { role: 'user', content: message },
              { role: 'assistant', content: immediateResult.result.text },
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
              current_agent_id: immediateAgent.id,
            });
            return {
              ...immediateResult.result,
              agentName: immediateAgent.service_step || immediateAgent.id,
              debug: {
                conversationId,
                externalUserId,
                originChannel,
                provider,
                model,
                agentId: immediateAgent.id,
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
        }
      }

      return {
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
        },
      };
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

    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        is_initial: true,
        activation_conditions: true,
        activation_mode: true,
      },
      orderBy: { execution_order: 'asc' },
    });

    if (agents.length === 0) return defaultAgentId;

    const currentAgentId =
      (mergedState.current_agent_id as string) || defaultAgentId;

    const pendingAgentId = mergedState.pending_agent_id as string | undefined;
    if (pendingAgentId) {
      const target = agents.find((a) => a.id === pendingAgentId);
      if (target) return target.id;
    }

    for (const agent of agents) {
      if (agent.id === currentAgentId) continue;
      const conditions =
        agent.activation_conditions as ActivationConditionGroup | null;
      if (!conditions) continue;
      if (evaluateConditions(conditions, mergedState)) {
        return agent.id;
      }
    }

    const currentAgent = agents.find((a) => a.id === currentAgentId);
    if (currentAgent) return currentAgent.id;

    return agents[0].id;
  }

  private async checkImmediateActivation(
    clientId: string,
    currentAgentId: string,
    contextVariables: Record<string, unknown>,
  ): Promise<any | null> {
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
      },
      orderBy: { execution_order: 'asc' },
    });

    for (const agent of agents) {
      if (agent.id === currentAgentId) continue;
      if (agent.activation_mode !== 'immediate') continue;
      const conditions =
        agent.activation_conditions as ActivationConditionGroup | null;
      if (!conditions) continue;
      if (evaluateConditions(conditions, contextVariables)) {
        return agent;
      }
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
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
    });
    const metadata = (client?.metadata as any) || {};

    const transitions = agent.transitions || {};
    const provider =
      transitions.llm_provider || process.env.LLM_PROVIDER || 'groq';
    const model = agent.model || 'openai/gpt-oss-120b';

    const providerCfg = metadata.llm_providers?.[provider];
    if (!providerCfg?.apiKey) {
      this.logger.warn(
        { provider },
        'processWithAgent: API Key nao encontrada para provider',
      );
      return null;
    }
    const apiKey = providerCfg.apiKey;

    const allowedToolNames = Array.isArray(agent.allowed_tool_names)
      ? agent.allowed_tool_names.filter(
          (tool: unknown): tool is string => typeof tool === 'string',
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
    apiTools.push(this.buildNativeHandoffApiTool());

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
    const entries = Object.entries(contextVariables).filter(
      ([, value]) => value !== undefined,
    );
    if (!entries.length) return systemPrompt;

    const basePrompt = systemPrompt || '';
    const replacedPrompt = basePrompt.replace(
      /\[\[([^\]]+)]]/g,
      (match, rawKey: string) => {
        const key = rawKey.trim();
        if (!Object.prototype.hasOwnProperty.call(contextVariables, key)) {
          return match;
        }
        return this.formatContextValue(contextVariables[key]);
      },
    );

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
      const resultData = (toolCall.result as any)?.data;
      if (resultData && typeof resultData === 'object') {
        Object.assign(merged, resultData);
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
          (name: unknown): name is string => typeof name === 'string',
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
    if (!this.canUseNativeRag(agentConfig)) return undefined;
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
      if (cfg.source !== 'ai') continue;
      properties[key] = {
        type: 'string',
        description:
          typeof cfg.value === 'string'
            ? `${cfg.value}. Passe sempre como string entre aspas.`
            : `Valor de ${key} preenchido pela IA. Passe sempre como string entre aspas.`,
      };
      required.add(key);
    }

    const params = this.asRecord(tool.parameters);
    for (const [key, config] of Object.entries(params)) {
      const cfg = this.asRecord(config);
      if (cfg.source && cfg.source !== 'ai') continue;
      properties[key] = {
        type: 'string',
        description:
          typeof cfg.value === 'string'
            ? `${cfg.value}. Passe sempre como string entre aspas.`
            : `Parametro ${key} para executar a API. Passe sempre como string entre aspas.`,
      };
      required.add(key);
    }

    return {
      type: 'object',
      properties,
      required: [...required],
      additionalProperties: false,
    };
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

  private async executeApiTool(tool: ApiTool, args: Record<string, unknown>) {
    if (!tool.url) throw new Error(`Tool ${tool.name} sem URL configurada`);

    let url = tool.url;
    for (const param of this.extractUrlParams(url)) {
      const value = args[param];
      if (value === undefined || value === null || value === '') {
        throw new Error(`Parametro obrigatorio ausente: ${param}`);
      }
      url = url.replace(`{${param}}`, encodeURIComponent(String(value)));
    }

    const method = (tool.method || 'GET').toUpperCase();
    const headers = this.asRecord(tool.headers);
    const init: RequestInit = { method, headers: headers as HeadersInit };
    const body = this.buildRequestBody(tool, args);
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

    const result = {
      ok: response.ok,
      status: response.status,
      data: this.applyExtractData(raw, tool.extract_data),
      raw,
    };

    if (!response.ok) {
      throw new Error(`Erro ao executar ${tool.name}: ${response.status}`);
    }

    return result;
  }

  private async executeNativeRagTool(
    args: Record<string, unknown>,
    message: string,
    context?: NativeRagRuntimeContext,
  ) {
    if (!context) {
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
      context.agentRunId,
      context.conversationId,
      context.messageId,
      context.companyId,
    );
  }

  private clampToolLimit(value: unknown) {
    const numeric = Number(value || 5);
    if (!Number.isFinite(numeric)) return 5;
    return Math.min(Math.max(Math.trunc(numeric), 1), 10);
  }

  private buildRequestBody(tool: ApiTool, args: Record<string, unknown>) {
    const body = this.asRecord(tool.body);
    if (!Object.keys(body).length) return undefined;

    const output: Record<string, unknown> = {};
    for (const [key, config] of Object.entries(body)) {
      const cfg = this.asRecord(config);
      if (cfg.source === 'ai') {
        output[key] = args[key];
      } else if ('value' in cfg) {
        output[key] = cfg.value;
      } else {
        output[key] = config;
      }
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
        if (cfg.rules?.length) {
          value = this.evaluateComparisonRules(value, cfg.rules);
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
    if (value === null || value === undefined || !rules.length) return value;

    for (const rule of rules) {
      const { operator, compare_value, return_value } = rule;

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
    const parts: any[] = [{ text: message }];
    const audioFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('audio/'),
    );

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
  ): Promise<string> {
    const normalizedProvider = provider.toLowerCase();
    const baseUrl =
      normalizedProvider === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : normalizedProvider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : '';

    if (!baseUrl) {
      throw new Error(`Visão não suportada para o provedor ${provider}`);
    }

    const model =
      process.env.MEDIA_VISION_MODEL ||
      (normalizedProvider === 'groq' ? 'qwen/qwen3.6-27b' : 'qwen/qwen3.6-27b');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Descreva esta imagem em português. Retorne apenas uma descrição concisa e o texto visível.',
              },
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
    });

    if (!response.ok) {
      throw new Error(
        `Falha na visão (${model}): ${response.status} ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | unknown[] } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      if (text) return text;
    }

    throw new Error('O provedor visual não retornou uma descrição');
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
    const provider = baseUrl.includes('groq') ? 'groq' : 'openrouter';
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
          await this.describeImageForChat(imageFile, provider, apiKey),
        );
      }
      userText = `${userText}\n\n${descriptions
        .map(
          (description) =>
            `<transcricao_imagem>\n${description}\n</transcricao_imagem>`,
        )
        .join('\n\n')}`;
    }
    messages.push({ role: 'user', content: userText });
    let responseMessage: any = null;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let loop = 0; loop < 8; loop++) {
      const payload: Record<string, unknown> = {
        model,
        messages,
        max_tokens: 4096,
      };
      if (openAiTools.length) {
        payload.tools = openAiTools;
        payload.tool_choice = 'auto';
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
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

        if (!tool && !isNativeWeb && !isNativeRag && !isNativeHandoff) {
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
          } else if (tool) {
            result = await this.executeApiTool(tool, args);
            toolCalls.push({ name: tool.name, arguments: args, result });
          } else {
            result = { error: `Tool ${functionName} nao encontrada` };
            toolCalls.push({ name: functionName, arguments: args, result });
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
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
        }
      }
    }

    return {
      text: responseMessage?.content || 'Sem resposta',
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
}
