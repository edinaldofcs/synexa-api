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

interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const TEST_CHAT_CONTEXT_KEY = 'test_chat_context_variables';

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

@Injectable()
export class TestChatService {
  private readonly logger = new Logger(TestChatService.name);
  private readonly memoryLimit = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly webSearchService: WebSearchService,
  ) {}

  async listModels(provider: string, apiKey: string): Promise<string[]> {
    switch (provider.toLowerCase()) {
      case 'gemini':
        return this.listGeminiModels(apiKey);
      case 'groq':
        return this.listGroqModels(apiKey);
      case 'openrouter':
        return this.listOpenRouterModels(apiKey);
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

    if (agentId && clientId) {
      const client = await this.prisma.painel_clients.findUnique({
        where: { id: clientId },
      });
      if (!client) throw new Error('Cliente nao encontrado');
      companyId = client.company_id;

      const metadata = (client.metadata as any) || {};
      contextVariables = this.sanitizeContextVariables(metadata);

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
          agentId,
          persistedContext,
        );
      }

      const agent = await this.prisma.painel_agents.findUnique({
        where: { id: resolvedAgentId },
      });
      if (!agent) throw new Error('Agente nao encontrado');

      resolvedAgentName = agent.service_step || agent.id;

      const transitions = (agent.transitions as any) || {};
      provider = transitions.llm_provider || provider;
      model = agent.model || model;
      systemPrompt = systemPrompt || agent.system_prompt || undefined;
      availableTools = Array.isArray((agent as any).allowed_tool_names)
        ? (agent as any).allowed_tool_names.filter(
            (tool: unknown): tool is string => typeof tool === 'string',
          )
        : [];
      allClientApiNames = await this.loadAllClientApiNames(clientId);
      apiTools = await this.loadApiTools(clientId, agent.id, availableTools);

      const capabilities =
        (transitions.capabilities as Record<string, boolean>) || {};
      const webSearch = (transitions.web_search as Record<string, unknown>) || {};
      if (capabilities.web_search !== false && webSearch.enabled !== false) {
        apiTools.push(this.buildNativeWebSearchApiTool());
      }

      availableTools = [
        ...new Set([...availableTools, ...apiTools.map((tool) => tool.name)]),
      ];

      const providerName = provider || '';
      const providerCfg = metadata.llm_providers?.[providerName];
      if (!providerCfg?.apiKey) {
        throw new Error(
          `API Key para ${provider} nao configurada em Configuracoes`,
        );
      }
      apiKey = providerCfg.apiKey;
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
      await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'customer',
        direction: 'inbound',
        channel: originChannel,
        content: message,
      });

      const result = await this.callProvider(
        provider,
        message,
        model,
        apiKey,
        files,
        this.buildContextualSystemPrompt(systemPrompt, contextVariables),
        history,
        apiTools,
        [],
      );

      await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'ai',
        direction: 'outbound',
        channel: originChannel,
        content: result.text,
      });

      await this.saveMemory(conversationId, [
        ...history,
        { role: 'user', content: message },
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
            contextVariables,
            history,
            memory,
          );
          if (immediateResult) {
            await this.saveMessage({
              conversationId,
              companyId,
              clientId,
              senderType: 'ai',
              direction: 'outbound',
              channel: originChannel,
              content: immediateResult.result.text,
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
  ): Promise<{ text: string; toolCalls?: ToolCallDebug[] }> {
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

    const capabilities =
      (transitions.capabilities as Record<string, boolean>) || {};
    const webSearch = (transitions.web_search as Record<string, unknown>) || {};
    if (capabilities.web_search !== false && webSearch.enabled !== false) {
      apiTools.push(this.buildNativeWebSearchApiTool());
    }

    const availableTools = [
      ...new Set([...allowedToolNames, ...apiTools.map((t) => t.name)]),
    ];

    const result = await this.callProvider(
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
    );

    return {
      result,
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
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();

    for (const param of this.extractUrlParams(tool.url || '')) {
      properties[param] = {
        type: 'string',
        description: `Valor para preencher {${param}} na URL da API.`,
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
            ? cfg.value
            : `Valor de ${key} preenchido pela IA.`,
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
            ? cfg.value
            : `Parametro ${key} para executar a API.`,
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

  private async saveMessage(params: {
    conversationId: string;
    companyId: string;
    clientId: string;
    senderType: string;
    direction: string;
    channel: string;
    content: string;
  }) {
    await this.prisma.messages.create({
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

  private async callGemini(
    message: string,
    model: string,
    apiKey: string,
    files?: { mimeType: string; data: string }[],
    systemPrompt?: string,
    history: MemoryMessage[] = [],
  ): Promise<{ text: string }> {
    const parts: any[] = [{ text: message }];
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
    return {
      text:
        json?.candidates?.[0]?.content?.parts
          ?.map((part: any) => part.text)
          .join('') || 'Sem resposta',
    };
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
  ): Promise<{ text: string; toolCalls?: ToolCallDebug[] }> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const item of history) {
      messages.push({ role: item.role, content: item.content });
    }

    const content: any[] = [{ type: 'text', text: message }];
    if (files?.length) {
      for (const file of files) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${file.mimeType};base64,${file.data}` },
        });
      }
    }
    messages.push({ role: 'user', content });

    const openAiTools = this.buildOpenAiTools(apiTools);
    const toolsByFunctionName = new Map(
      apiTools.map((tool) => [tool.functionName, tool]),
    );
    let responseMessage: any = null;

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
      responseMessage = json?.choices?.[0]?.message;
      if (!responseMessage) break;

      messages.push(responseMessage);
      const calls = responseMessage.tool_calls || [];
      if (!calls.length) break;

      for (const call of calls) {
        const functionName = call?.function?.name;
        const tool = toolsByFunctionName.get(functionName);
        const args = this.parseToolArguments(call?.function?.arguments);

        const isNative = functionName === this.webSearchService.getNativeToolId();

        if (!tool && !isNative) {
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
          if (isNative) {
            const nativeArgs = this.withFallbackQuery(args, message);
            result = await this.webSearchService.execute(nativeArgs);
            toolCalls.push({
              name: 'web_search',
              arguments: nativeArgs,
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
