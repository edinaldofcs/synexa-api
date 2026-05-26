import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { getLLMProvider } from './providers/llm-provider.factory';
import { llmConfig } from './providers/llm-config';
import type {
  LLMProvider,
  AgentChatParams,
  ProviderCapabilities,
} from './providers/llm-provider.interface';
import type {
  AgentMessage,
  AgentOutput,
  MessagePart,
} from './types/agent-message.types';
import type {
  AgentCapabilities,
  AgentConfig,
} from './types/capabilities.types';
import { DEFAULT_CAPABILITIES } from './types/capabilities.types';
import { sanitize } from '../common/utils/sanitize-log.util';
import {
  evaluateConditions,
  type ActivationConditionGroup,
} from './utils/condition-evaluator.util';

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

@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);
  private readonly openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
  private readonly embeddingModel =
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly conversationsService: ConversationsService,
  ) {}

  async processMessage(
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    text: string,
    requestId?: string,
  ): Promise<ProcessMessageResult> {
    const state = await this.conversationsService.getState(conversationId);
    const conversation =
      await this.conversationsService.getConversation(conversationId);

    const agentConfig = await this.resolveAgentConfig(clientId, state);

    await this.conversationsService.updateState(conversationId, {
      ...state,
      current_agent_id: agentConfig.agentId,
    });
    const provider = getLLMProvider();
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
        provider: process.env.LLM_PROVIDER || 'gemini',
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

    const inputParts = await this.buildInputParts(
      inboundMessage,
      agentConfig,
      providerCapabilities,
    );

    const history = await this.buildHistory(
      conversationId,
      agentConfig,
      providerCapabilities,
    );

    const ragContext = await this.buildRagContext(
      agentConfig,
      text,
      clientId,
      agentRun.id,
      conversationId,
      messageId,
      companyId,
      requestId,
    );
    const systemPrompt = ragContext
      ? `${agentConfig.system_prompt}\n\nContexto RAG disponivel:\n${ragContext}\n\nUse o contexto apenas quando ele for relevante.`
      : agentConfig.system_prompt;

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
        this.logger.log(
          { toolName: sanitize(String(toolName)), args: sanitize(args) },
          'Native tool call',
        );
        switch (toolName) {
          case 'rag.search':
            return this.searchRag(
              agentConfig,
              String(args.query || text),
              clientId,
              Number(args.limit || 5),
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              requestId,
            );
          case 'web.search':
            return this.searchWeb(
              agentConfig,
              String(args.query || ''),
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              requestId,
            );
          case 'media.transcribe':
            return this.transcribeMedia(
              String(args.media_asset_id || ''),
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              clientId,
              requestId,
            );
          case 'media.describe_image':
            return this.describeImageMedia(
              String(args.media_asset_id || ''),
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              clientId,
              requestId,
            );
          case 'switch_agent':
            return this.handleSwitchAgent(
              String(args.target_agent || ''),
              String(args.reason || ''),
              clientId,
              conversationId,
              state,
            );
          case 'set_variable':
            return this.handleSetVariable(
              args.variables as Record<string, unknown> || {},
              conversationId,
              state,
            );
          default:
            return { result: 'tool_executed', toolName };
        }
      },
    };

    try {
      if (provider.chatWithParts) {
        this.logger.log(
          {
            conversationId: sanitize(conversationId),
            companyId: sanitize(companyId),
          },
          'Processing with chatWithParts',
        );
        const output = await provider.chatWithParts(params);
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
        );
        return { ...result, agentId: agentConfig.agentId };
      }

      const legacyOutput = await provider.chat({
        systemPrompt: agentConfig.system_prompt,
        userMessage: text,
        history: [{ role: 'user', content: text }],
        publicTools: [],
        allToolsList: [],
        executeExternalApiCallback: async () => ({}),
      });

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

      await this.completeAgentRun(agentRun.id, 'success', responseMessage.id);

      return {
        responseText: legacyOutput.text,
        responseMessageId: responseMessage.id,
        agentId: agentConfig.agentId,
        hadTools: false,
        calledTools: [],
      };
    } catch (error) {
      await this.failAgentRun(agentRun.id, error);
      throw error;
    }
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
          const description =
            asset?.ocr_text || '[Imagem sem descricao disponivel]';
          parts.push({ type: 'text', text: `[Imagem: ${description}]` });
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
          const transcript =
            asset?.transcript || '[Audio sem transcricao disponivel]';
          parts.push({
            type: 'text',
            text: `[Audio transcrito: ${transcript}]`,
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
    agentConfig: AgentConfig,
    providerCapabilities: ProviderCapabilities,
  ): Promise<AgentMessage[]> {
    const conversation =
      await this.conversationsService.getConversation(conversationId);
    const messages = (conversation as any).messages || [];

    const history: AgentMessage[] = [];

    for (const msg of messages.slice(-20)) {
      if (msg.id === conversationId) continue;

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
                text: `[Imagem: ${asset?.ocr_text || 'sem descricao'}]`,
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
                text: `[Audio: ${asset?.transcript || 'sem transcricao'}]`,
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

  private buildToolDefinitions(agentConfig: AgentConfig) {
    const tools: any[] = [];

    if (
      agentConfig.capabilities.rag &&
      agentConfig.allowed_knowledge_base_ids.length > 0
    ) {
      tools.push(this.ragToolDefinition());
    }

    if (agentConfig.capabilities.web_search && agentConfig.web_search_allowed) {
      tools.push(this.webSearchToolDefinition());
    }

    if (agentConfig.capabilities.tools) {
      tools.push(this.mediaTranscribeToolDefinition());
      tools.push(this.mediaDescribeImageToolDefinition());
      tools.push(this.switchAgentToolDefinition());
      tools.push(this.setVariableToolDefinition());
    }

    return tools;
  }

  private switchAgentToolDefinition() {
    return {
      name: 'switch_agent',
      description:
        'Transfere a conversa para outro agente. Use quando identificar que o agente atual não é o mais adequado para a solicitação do usuário.',
      parameters: {
        type: 'object',
        properties: {
          target_agent: {
            type: 'string',
            description:
              'Nome (service_step) ou ID do agente de destino para transferir a conversa',
          },
          reason: {
            type: 'string',
            description: 'Motivo da transferência (opcional)',
          },
        },
        required: ['target_agent'],
      },
    };
  }

  private setVariableToolDefinition() {
    return {
      name: 'set_variable',
      description:
        'Define uma ou mais variáveis no estado da conversa para controle de fluxo entre agentes.',
      parameters: {
        type: 'object',
        properties: {
          variables: {
            type: 'object',
            description:
              'Objeto com as variáveis a serem definidas. Ex: {"intent": "suporte", "sentiment": "positive"}',
            additionalProperties: true,
          },
        },
        required: ['variables'],
      },
    };
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

    return {
      responseText: output.text,
      responseMessageId: message.id,
      responseParts: output.parts,
      hadTools: calledTools.length > 0,
      calledTools,
      citations: output.citations,
    };
  }

  private async resolveAgentConfig(
    clientId: string,
    state: Record<string, unknown>,
  ): Promise<AgentConfig & { agentId: string }> {
    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      orderBy: { execution_order: 'asc' },
    });

    if (agents.length === 0) {
      return this.buildDefaultAgentConfig();
    }

    const currentAgentId = state.current_agent_id as string | undefined;

    if (!currentAgentId) {
      const initialAgent =
        agents.find((a) => a.is_initial) || agents[0];
      return this.agentRecordToConfig(initialAgent as any);
    }

    const pendingAgentId = state.pending_agent_id as string | undefined;
    if (pendingAgentId) {
      const targetAgent = agents.find((a) => a.id === pendingAgentId);
      if (targetAgent) {
        return this.agentRecordToConfig(targetAgent as any);
      }
    }

    for (const agent of agents) {
      if (agent.id === currentAgentId) continue;
      const conditions = agent.activation_conditions as ActivationConditionGroup | null;
      if (!conditions) continue;

      if (evaluateConditions(conditions, state)) {
        return this.agentRecordToConfig(agent as any);
      }
    }

    const currentAgent = agents.find((a) => a.id === currentAgentId);
    if (currentAgent) {
      return this.agentRecordToConfig(currentAgent as any);
    }

    return this.agentRecordToConfig(agents[0] as any);
  }

  private buildDefaultAgentConfig(): AgentConfig & { agentId: string } {
    return {
      agentId: 'default',
      id: 'default',
      name: 'default',
      model: llmConfig.models.gemini,
      system_prompt: 'You are a helpful assistant.',
      capabilities: { ...DEFAULT_CAPABILITIES },
      citation_policy: { policy: 'optional' },
      allowed_knowledge_base_ids: [],
      allowed_tool_names: [],
      web_search_allowed: false,
      web_search_domains_allowed: [],
      web_search_domains_blocked: [],
      temperature: 0.3,
    };
  }

  private agentRecordToConfig(
    painelAgent: any,
  ): AgentConfig & { agentId: string } {
    const transitions =
      (painelAgent?.transitions as Record<string, unknown>) || {};
    const ws =
      (transitions.web_search as Record<string, unknown>) || {};

    return {
      agentId: painelAgent?.id || 'default',
      id: painelAgent?.id || 'default',
      name: painelAgent?.service_step || 'default',
      model: painelAgent?.model || llmConfig.models.gemini,
      system_prompt:
        painelAgent?.system_prompt || 'You are a helpful assistant.',
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...(transitions.capabilities as Partial<AgentCapabilities>),
      },
      citation_policy: { policy: 'optional' },
      allowed_knowledge_base_ids: Array.isArray(
        transitions.allowed_knowledge_base_ids,
      )
        ? (transitions.allowed_knowledge_base_ids as string[])
        : [],
      allowed_tool_names: [],
      web_search_allowed: ws.enabled === true,
      web_search_domains_allowed: Array.isArray(ws.domains_allowed)
        ? (ws.domains_allowed as string[])
        : [],
      web_search_domains_blocked: Array.isArray(ws.domains_blocked)
        ? (ws.domains_blocked as string[])
        : [],
      temperature: 0.3,
    };
  }

  private async handleSetVariable(
    variables: Record<string, unknown>,
    conversationId: string,
    _state: Record<string, unknown>,
  ) {
    if (!variables || Object.keys(variables).length === 0) {
      return { result: 'no_variables', message: 'Nenhuma variável fornecida.' };
    }

    const freshState = await this.conversationsService.getState(conversationId);
    await this.conversationsService.updateState(conversationId, {
      ...freshState,
      ...variables,
    });

    this.logger.log(
      { keys: sanitize(String(Object.keys(variables))) },
      'set_variable: variáveis atualizadas',
    );

    return {
      result: 'variables_set',
      message: `${Object.keys(variables).length} variável(is) definida(s).`,
      variables_set: Object.keys(variables),
    };
  }

  private async handleSwitchAgent(
    targetAgent: string,
    reason: string,
    clientId: string,
    conversationId: string,
    _state: Record<string, unknown>,
  ) {
    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: { id: true, service_step: true },
    });

    const target = agents.find(
      (a) => a.id === targetAgent || a.service_step === targetAgent,
    );

    if (!target) {
      this.logger.warn(
        { targetAgent, clientId },
        'switch_agent: target agent not found',
      );
      return {
        result: 'agent_not_found',
        message: `Agente "${targetAgent}" não encontrado.`,
      };
    }

    const freshState = await this.conversationsService.getState(conversationId);
    await this.conversationsService.updateState(conversationId, {
      ...freshState,
      pending_agent_id: target.id,
      switch_reason: reason || null,
    });

    this.logger.log(
      {
        from: sanitize(String(freshState.current_agent_id || 'unknown')),
        to: sanitize(target.service_step || target.id),
        reason: sanitize(reason || 'sem motivo'),
      },
      'switch_agent: transferência agendada',
    );

    return {
      result: 'agent_switched',
      message: `Conversa transferida para "${target.service_step || target.id}".`,
      target_agent: target.service_step || target.id,
    };
  }

  private async buildRagContext(
    agentConfig: AgentConfig,
    query: string,
    clientId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ) {
    if (
      !agentConfig.capabilities.rag ||
      agentConfig.allowed_knowledge_base_ids.length === 0
    )
      return undefined;

    const results = await this.searchRag(
      agentConfig,
      query,
      clientId,
      5,
      agentRunId,
      conversationId,
      messageId,
      companyId,
      requestId,
    );
    if (!results.length) return undefined;

    return results
      .map(
        (item, index) =>
          `[${index + 1}] ${item.document_title || item.document_id}\n${item.content}`,
      )
      .join('\n\n');
  }

  private async searchRag(
    agentConfig: AgentConfig,
    query: string,
    clientId: string,
    limit: number,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ) {
    if (!this.openai || agentConfig.allowed_knowledge_base_ids.length === 0)
      return [];
    const startedAt = Date.now();
    const toolCall = await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'rag.search',
        tool_type: 'native',
        arguments: { query, limit } as any,
        status: 'running',
      },
    });

    try {
      const embeddingResponse = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: query,
      });
      const embedding = `[${embeddingResponse.data[0].embedding.join(',')}]`;

      const results = await this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          document_id: string;
          document_title: string;
          content: string;
          page: number | null;
          score: number;
        }>
      >(
        `
        SELECT
          kc.id,
          kc.document_id,
          kd.title AS document_title,
          kc.content,
          kc.page,
          1 - (ke.embedding <=> $1::vector) AS score
        FROM knowledge_embeddings ke
        JOIN knowledge_chunks kc ON kc.id = ke.chunk_id
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE ke.client_id = $2::uuid
          AND ke.knowledge_base_id = ANY($3::uuid[])
        ORDER BY ke.embedding <=> $1::vector
        LIMIT $4
        `,
        embedding,
        clientId,
        agentConfig.allowed_knowledge_base_ids,
        Math.min(Math.max(limit || 5, 1), 10),
      );

      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'success',
          latency_ms: Date.now() - startedAt,
          result: {
            count: results.length,
            chunks: results.map((r) => ({ id: r.id, score: r.score })),
          } as any,
          completed_at: new Date(),
        },
      });
      return results;
    } catch (error) {
      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'failed',
          latency_ms: Date.now() - startedAt,
          error_message:
            error instanceof Error ? error.message : 'RAG search failed',
          completed_at: new Date(),
        },
      });
      throw error;
    }
  }

  private async searchWeb(
    agentConfig: AgentConfig,
    query: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ): Promise<{ result: string; sources: string[] }> {
    const startedAt = Date.now();

    const toolCall = await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id:
          agentConfig.id === 'default'
            ? '00000000-0000-0000-0000-000000000000'
            : agentConfig.id,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'web.search',
        tool_type: 'native',
        arguments: { query } as any,
        status: 'running',
      },
    });

    try {
      const apiKey = process.env.WEB_SEARCH_API_KEY || process.env.SERPAPI_KEY;
      const engine = process.env.WEB_SEARCH_ENGINE || 'google';

      if (!apiKey) {
        return {
          result: 'Web search nao configurado (WEB_SEARCH_API_KEY ausente).',
          sources: [],
        };
      }

      const cacheKey = `websearch:${createHash('md5').update(query.toLowerCase().trim()).digest('hex')}`;
      const cached = await this.redisService.get<{
        results: string[];
        sources: string[];
      }>(cacheKey);
      if (cached) {
        await this.completeWebSearchTool(
          toolCall.id,
          startedAt,
          cached.results,
          cached.sources,
        );
        return { result: cached.results.join('\n\n'), sources: cached.sources };
      }

      let searchResults: string[] = [];
      let sources: string[] = [];

      if (engine === 'serpapi') {
        const url = new URL('https://serpapi.com/search');
        url.searchParams.set('q', query);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('engine', 'google');

        const response = await fetch(url.toString());
        const data = await response.json();

        if (data.organic_results) {
          const allowed = agentConfig.web_search_domains_allowed;
          const blocked = agentConfig.web_search_domains_blocked;
          const filtered = data.organic_results.filter((r: any) => {
            const link = (r.link || '').toLowerCase();
            if (allowed.length > 0)
              return allowed.some((d) => link.includes(d.toLowerCase()));
            if (blocked.length > 0)
              return !blocked.some((d) => link.includes(d.toLowerCase()));
            return true;
          });
          searchResults = filtered
            .slice(0, 5)
            .map((r: any) => `${r.title}\n${r.snippet}`);
          sources = filtered.slice(0, 5).map((r: any) => r.link);
        }
      } else {
        const url = new URL('https://www.googleapis.com/customsearch/v1');
        url.searchParams.set('q', query);
        url.searchParams.set('key', apiKey);
        url.searchParams.set('cx', process.env.WEB_SEARCH_CX || '');

        const response = await fetch(url.toString());
        const data = await response.json();

        if (data.items) {
          const allowed = agentConfig.web_search_domains_allowed;
          const blocked = agentConfig.web_search_domains_blocked;
          const filtered = data.items.filter((r: any) => {
            const link = (r.link || '').toLowerCase();
            if (allowed.length > 0)
              return allowed.some((d) => link.includes(d.toLowerCase()));
            if (blocked.length > 0)
              return !blocked.some((d) => link.includes(d.toLowerCase()));
            return true;
          });
          searchResults = filtered
            .slice(0, 5)
            .map((r: any) => `${r.title}\n${r.snippet}`);
          sources = filtered.slice(0, 5).map((r: any) => r.link);
        }
      }

      const resultText =
        searchResults.length > 0
          ? searchResults.join('\n\n')
          : 'Nenhum resultado encontrado.';

      await this.redisService.set(cacheKey, {
        results: searchResults,
        sources,
      });

      await this.completeWebSearchTool(
        toolCall.id,
        startedAt,
        searchResults,
        sources,
      );

      return { result: resultText, sources };
    } catch (error) {
      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'failed',
          latency_ms: Date.now() - startedAt,
          error_message:
            error instanceof Error ? error.message : 'Web search failed',
          completed_at: new Date(),
        },
      });

      return {
        result: `Erro na busca web: ${error instanceof Error ? error.message : 'unknown'}`,
        sources: [],
      };
    }
  }

  private async completeWebSearchTool(
    toolCallId: string,
    startedAt: number,
    results: string[],
    sources: string[],
  ) {
    await this.prisma.tool_calls.update({
      where: { id: toolCallId },
      data: {
        status: 'success',
        latency_ms: Date.now() - startedAt,
        result: { count: results.length, sources } as any,
        completed_at: new Date(),
      },
    });
  }

  private async transcribeMedia(
    mediaAssetId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    requestId?: string,
  ) {
    if (!mediaAssetId) return { error: 'media_asset_id é obrigatório' };

    const startedAt = Date.now();
    await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'media.transcribe',
        tool_type: 'native',
        arguments: { media_asset_id: mediaAssetId } as any,
        status: 'completed',
        latency_ms: 0,
        completed_at: new Date(),
      },
    });

    const asset = await this.prisma.media_assets.findUnique({
      where: { id: mediaAssetId },
    });
    if (!asset) return { error: 'Media asset not found' };
    if (asset.transcript) return { transcript: asset.transcript };

    return {
      error:
        'Transcricao ainda nao disponivel. O audio pode estar sendo processado.',
    };
  }

  private async describeImageMedia(
    mediaAssetId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    requestId?: string,
  ) {
    if (!mediaAssetId) return { error: 'media_asset_id é obrigatório' };

    const startedAt = Date.now();
    await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'media.describe_image',
        tool_type: 'native',
        arguments: { media_asset_id: mediaAssetId } as any,
        status: 'completed',
        latency_ms: 0,
        completed_at: new Date(),
      },
    });

    const asset = await this.prisma.media_assets.findUnique({
      where: { id: mediaAssetId },
    });
    if (!asset) return { error: 'Media asset not found' };
    if (asset.ocr_text) return { description: asset.ocr_text };

    return {
      error:
        'Descricao ainda nao disponivel. A imagem pode estar sendo processada.',
    };
  }

  private async completeAgentRun(
    agentRunId: string,
    status: string,
    responseMessageId?: string,
  ) {
    const current = await this.prisma.agent_runs.findUnique({
      where: { id: agentRunId },
    });
    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        status,
        response_message_id: responseMessageId || null,
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

  private ragToolDefinition() {
    return {
      name: 'rag.search',
      type: 'native' as const,
      description:
        'Busca informacoes nas bases de conhecimento autorizadas para este agente.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca' },
          limit: { type: 'number', description: 'Maximo de resultados (1-10)' },
        },
        required: ['query'],
      },
    };
  }

  private webSearchToolDefinition() {
    return {
      name: 'web.search',
      type: 'native' as const,
      description:
        'Consulta a internet para obter informacoes atualizadas. Pode ser usado quando o usuario pede noticias, dados recentes ou informacoes que o assistente nao conhece.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Consulta para busca na internet',
          },
        },
        required: ['query'],
      },
    };
  }

  private mediaTranscribeToolDefinition() {
    return {
      name: 'media.transcribe',
      type: 'native' as const,
      description:
        'Transcreve um audio para texto. Use quando o usuario enviar um audio e precisar do conteudo transcrito.',
      parameters: {
        type: 'object',
        properties: {
          media_asset_id: {
            type: 'string',
            description: 'ID do media asset do audio',
          },
        },
        required: ['media_asset_id'],
      },
    };
  }

  private mediaDescribeImageToolDefinition() {
    return {
      name: 'media.describe_image',
      type: 'native' as const,
      description:
        'Descreve o conteudo de uma imagem ou extrai texto visivel (OCR). Use quando o usuario enviar uma imagem.',
      parameters: {
        type: 'object',
        properties: {
          media_asset_id: {
            type: 'string',
            description: 'ID do media asset da imagem',
          },
        },
        required: ['media_asset_id'],
      },
    };
  }
}
