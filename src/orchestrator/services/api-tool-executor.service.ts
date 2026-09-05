import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConversationsService } from '../../conversations/conversations.service';
import { WebSearchService } from '../../agents/web-search/web-search.service';
import { RagSearchService } from './rag-search.service';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import {
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type AgentConfig,
} from '../types/capabilities.types';
import { resolveChainedApiId } from '../../common/utils/api-chaining.util';
import { validateWebhookUrl } from '../../common/utils/ssrf-guard';
import {
  HANDOFF_TOOL_NAME,
  LEGACY_TOOL_NAMES,
  RAG_SEARCH_TOOL_ID,
} from '../constants/tools.constants';

export {
  HANDOFF_TOOL_NAME,
  LEGACY_TOOL_NAMES,
  RAG_SEARCH_TOOL_ID,
} from '../constants/tools.constants';

export interface ApiTool {
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
  client_id?: string;
}

export interface ToolCallDebug {
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

export interface NativeRagRuntimeContext {
  agentConfig?: AgentConfig;
  clientId: string;
  companyId: string;
  conversationId?: string;
  messageId?: string;
  agentRunId?: string;
}

export interface ToolCallContext {
  message: string;
  nativeRagContext?: NativeRagRuntimeContext;
  /** Callback de chamada LLM (usado por subagentes) — invertido para evitar
   *  dependência circular com o loop de LLM. */
  callLlm: (params: {
    provider: string;
    model: string;
    apiKey: string;
    message: string;
    files?: { mimeType: string; data: string }[];
    systemPrompt?: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    tools: ApiTool[];
    context?: NativeRagRuntimeContext;
  }) => Promise<{
    text: string;
    toolCalls?: ToolCallDebug[];
    transcription?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }>;
}

/**
 * Executor único de ferramentas do pipeline de IA (usado pelo Test Chat e
 * disponível para a engine de produção): catálogo de tools do agente (APIs
 * do cliente + nativas + subagentes), execução HTTP com encadeamento e
 * extração de dados, e merge dos resultados nas variáveis de sessão.
 */
@Injectable()
export class ApiToolExecutorService {
  private readonly logger = new Logger(ApiToolExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webSearchService: WebSearchService,
    private readonly ragSearchService: RagSearchService,
    private readonly conversationsService: ConversationsService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
  ) {}

  // ── Catálogo de tools do agente ─────────────────────────────────

  async loadAgentTools(params: {
    clientId: string;
    agent: {
      id: string;
      allowed_tool_names?: unknown;
      transitions?: unknown;
    };
    agentConfig: AgentConfig;
  }): Promise<{
    apiTools: ApiTool[];
    availableTools: string[];
    allClientApiNames: string[];
  }> {
    const transitions = this.asRecord(params.agent.transitions);
    const availableTools = Array.isArray(params.agent.allowed_tool_names)
      ? (params.agent.allowed_tool_names as unknown[]).filter(
          (tool: unknown): tool is string =>
            typeof tool === 'string' && !LEGACY_TOOL_NAMES.has(tool),
        )
      : [];

    const allClientApiNames = await this.loadAllClientApiNames(params.clientId);
    const apiTools = await this.loadApiTools(
      params.clientId,
      params.agent.id,
      availableTools,
    );

    const capabilities = this.asRecord(transitions.capabilities);
    const webSearch = this.asRecord(transitions.web_search);
    if (capabilities.web_search !== false && webSearch.enabled !== false) {
      apiTools.push(this.buildNativeWebSearchApiTool());
    }
    if (this.canUseNativeRag(params.agentConfig)) {
      apiTools.push(this.buildNativeRagApiTool());
    }
    if (availableTools.includes(HANDOFF_TOOL_NAME)) {
      apiTools.push(this.buildNativeHandoffApiTool());
    }

    const subagentTools = await this.loadSubagentTools(
      params.clientId,
      transitions,
    );
    apiTools.push(...subagentTools);

    return {
      apiTools,
      availableTools: [
        ...new Set([...availableTools, ...apiTools.map((tool) => tool.name)]),
      ],
      allClientApiNames,
    };
  }

  async loadSubagentTools(
    clientId: string,
    transitions: Record<string, unknown>,
  ): Promise<ApiTool[]> {
    const allowedSubagents = Array.isArray(transitions.allowed_subagents)
      ? (transitions.allowed_subagents as string[])
      : Array.isArray(transitions.allowed_subagent_ids)
        ? (transitions.allowed_subagent_ids as string[])
        : [];
    if (allowedSubagents.length === 0) return [];

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

    if (orConditions.length === 0) return [];

    const subagentRecords = await this.prisma.painel_subagents.findMany({
      where: {
        client_id: clientId,
        is_active: true,
        OR: orConditions,
      },
    });
    return subagentRecords.map((sub) => this.buildSubagentApiTool(sub));
  }

  async loadApiTools(
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
      client_id: clientId,
    }));
  }

  async loadAllClientApiNames(clientId: string): Promise<string[]> {
    const apis = await this.prisma.painel_apis.findMany({
      where: { client_id: clientId, active: true },
      select: { name: true },
    });
    return apis.map((api) => api.name);
  }

  toFunctionName(name: string, id: string) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
      .toLowerCase();
    return `${slug || 'tool'}_${id.replace(/-/g, '_')}`;
  }

  buildNativeWebSearchApiTool(): ApiTool {
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

  buildNativeRagApiTool(): ApiTool {
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

  buildNativeHandoffApiTool(): ApiTool {
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

  buildSubagentApiTool(subagent: {
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

  canUseNativeRag(agentConfig?: AgentConfig): agentConfig is AgentConfig {
    return Boolean(
      agentConfig?.capabilities.rag === true &&
      agentConfig.allowed_knowledge_base_ids.length > 0,
    );
  }

  buildAgentConfigFromRecord(agent: any): AgentConfig {
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

  // ── Execução de tool calls ──────────────────────────────────────

  /** Despacha um tool call do LLM (nativa web/RAG/handoff, subagente ou API). */
  async executeToolCall(params: {
    tool?: ApiTool;
    functionName: string;
    args: Record<string, unknown>;
    context: ToolCallContext;
  }): Promise<ToolCallDebug> {
    const { tool, functionName, args, context } = params;

    const isNativeWeb =
      functionName === this.webSearchService.getNativeToolId();
    const isNativeRag = functionName === RAG_SEARCH_TOOL_ID;
    const isNativeHandoff =
      functionName === 'transfer_to_human' ||
      functionName === 'request_handoff';
    const isSubagent = functionName.startsWith('subagent_');

    if (isNativeWeb) {
      const nativeArgs = this.withFallbackQuery(args, context.message);
      const result = await this.webSearchService.execute(nativeArgs);
      return { name: 'web_search', arguments: nativeArgs, result };
    }

    if (isNativeRag) {
      const nativeArgs = this.withFallbackQuery(args, context.message);
      const result = await this.executeNativeRagTool(
        nativeArgs,
        context.message,
        context.nativeRagContext,
      );
      return {
        name: 'rag.search',
        arguments: {
          ...nativeArgs,
          limit: this.clampToolLimit(nativeArgs.limit),
        },
        result,
      };
    }

    if (isNativeHandoff) {
      const convId = context.nativeRagContext?.conversationId;
      if (convId) {
        await this.conversationsService.requestHandoff(convId, {
          reason: String(args.reason || 'solicitação no chat'),
          requested_by: 'ai_tool',
        });
      }
      const result = {
        status: 'transferred',
        message:
          'Atendimento transferido para a equipe de atendentes humanos com sucesso. Avise o cliente cordialmente que um operador irá atendê-lo a seguir.',
      };
      return { name: 'transfer_to_human', arguments: args, result };
    }

    if (isSubagent) {
      const result = await this.executeSubagentTool(
        functionName,
        args,
        context.nativeRagContext?.clientId || '',
        context.nativeRagContext?.companyId || '',
        context.nativeRagContext?.conversationId,
        context.callLlm,
      );
      return { name: functionName, arguments: args, result };
    }

    if (tool) {
      const sessionState = await this.getSessionState(
        context.nativeRagContext?.conversationId,
      );
      const result = await this.executeApiTool(tool, args, sessionState);
      return { name: tool.name, arguments: args, result };
    }

    return {
      name: functionName,
      arguments: args,
      result: { error: `Tool ${functionName} nao encontrada` },
    };
  }

  /** Estado da sessão (conversation_state) usado para resolver valores de
   *  body/URL das APIs. */
  async getSessionState(
    conversationId?: string,
  ): Promise<Record<string, unknown>> {
    if (!conversationId) return {};
    const cs = await this.prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
    });
    return (cs?.state as Record<string, unknown>) || {};
  }

  private async executeSubagentTool(
    subagentFnName: string,
    args: Record<string, unknown>,
    clientId: string,
    companyId: string,
    conversationId?: string,
    callLlm?: ToolCallContext['callLlm'],
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
      // Usa o modelo configurado no subagente; aplica default apenas quando
      // não há modelo definido (não descarta configuração válida do cliente)
      let model = subagent.model || '';
      if (!model) {
        model =
          provider.toLowerCase() === 'gemini'
            ? 'gemini-3.6-flash'
            : 'llama-3.3-70b-versatile';
      }

      const apiKey = await this.resolveSubagentApiKey(
        resolvedClientId,
        provider,
      );
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

      if (!callLlm) {
        return { error: 'Loop de LLM indisponível para subagente.' };
      }

      const subResult = await callLlm({
        provider,
        model,
        apiKey,
        message: userMessage,
        systemPrompt: subagent.system_prompt,
        history: [],
        tools: subagentApiTools,
        context: {
          clientId: resolvedClientId,
          companyId,
          conversationId,
        },
      });

      return {
        status: 'completed',
        subagent: subagent.name,
        response: subResult.text,
        tools_executed: (subResult.toolCalls || []).map((tc) => tc.name),
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

  private async resolveSubagentApiKey(
    clientId: string,
    provider: string,
  ): Promise<string> {
    let apiKey = await this.providerKeyResolver.resolveApiKey(
      clientId,
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
    return apiKey;
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

  // ── Execução de APIs (painel_apis) ──────────────────────────────

  private async executeApiTool(
    tool: ApiTool,
    args: Record<string, unknown>,
    sessionState?: Record<string, unknown>,
    visited?: Set<string>,
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

    await validateWebhookUrl(url, process.env.ENVIRONMENT === 'development');

    const method = (tool.method || 'GET').toUpperCase();
    const headers = this.asRecord(tool.headers);
    const init: RequestInit = {
      method,
      headers: headers as HeadersInit,
      signal: AbortSignal.timeout(15_000),
    };
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
    // Respostas 204/corpo vazio não têm JSON válido: ler como texto e só
    // então tentar parse evita exceção em No Content / corpo vazio.
    let raw: unknown = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        if (contentType.includes('application/json')) {
          try {
            raw = JSON.parse(text);
          } catch {
            raw = text;
          }
        } else {
          raw = text;
        }
      }
    }

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

    // Encadeamento: regras condicionais (_chaining) ou direto (next_api_id/next_tool)
    const legacyNextApiId =
      (headers.next_api_id as string) || (tool as any).next_tool;
    const nextApiId = resolveChainedApiId(
      tool.extract_data,
      extracted,
      legacyNextApiId,
    );
    if (response.ok && nextApiId) {
      const chainVisited = visited ?? new Set([tool.id]);
      if (chainVisited.has(nextApiId)) {
        this.logger.warn(
          `Ciclo detectado no encadeamento de APIs (${nextApiId}); cadeia abortada`,
        );
      } else {
        try {
          const nextApi = await this.prisma.painel_apis.findFirst({
            where: {
              OR: [{ id: nextApiId }, { name: nextApiId }],
              active: true,
              ...(tool.client_id ? { client_id: tool.client_id } : {}),
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
            const nextVisited = new Set(chainVisited);
            nextVisited.add(nextApi.id);
            const nextResult = await this.executeApiTool(
              nextTool,
              nextArgs,
              sessionState,
              nextVisited,
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
    }

    return result;
  }

  // ── Merge dos resultados nas variáveis de sessão ────────────────

  mergeToolResults(
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

  // ── Helpers privados ────────────────────────────────────────────

  /** Monta as tool definitions no formato OpenAI para o loop do LLM. */
  buildOpenAiTools(apiTools: ApiTool[]) {
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

  asRecord(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
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
        // Fallbacks de CPF só se aplicam a campos de CPF — nunca vaziam o
        // CPF para campos system sem relação (ex.: valor, protocolo).
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
          (isCpfField ? (args as any)['cliente_cpf'] : undefined) ??
          (isCpfField ? (args as any)['cpf'] : undefined) ??
          (args as any)[varName] ??
          (args as any)[key];
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
      if (key === '_chaining') continue;
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
          fallback?: unknown;
          fallback_type?: string;
          max_items?: number;
          rules?: Array<{
            operator: string;
            compare_value: string;
            return_value: unknown;
            return_type?: string;
          }>;
        };
        let value = this.getByPath(
          raw as Record<string, unknown>,
          cfg.path || '',
        );

        if (Array.isArray(value) && cfg.max_items && cfg.max_items > 0) {
          value = value.slice(0, cfg.max_items);
        }

        let matchedRule = false;
        if (cfg.rules?.length) {
          const res = this.evaluateComparisonRules(value, cfg.rules, raw);
          value = res.value;
          matchedRule = res.matched;
        }

        if (cfg.modifier && (!cfg.rules?.length || matchedRule)) {
          value = this.applyExtractModifier(value, cfg.modifier);
        }

        const isMissing = value === null || value === undefined || value === '';
        const ruleFailedWithFallback =
          Boolean(cfg.rules?.length) &&
          !matchedRule &&
          cfg.fallback !== undefined;

        if (
          (isMissing || ruleFailedWithFallback) &&
          cfg.fallback !== undefined
        ) {
          const fb: any = cfg.fallback;
          if (cfg.fallback_type === 'path') {
            value = this.getByPath(raw, String(fb));
          } else if (
            cfg.fallback_type === 'boolean' ||
            fb === true ||
            fb === false ||
            fb === 'true' ||
            fb === 'false'
          ) {
            value = fb === true || fb === 'true';
          } else if (cfg.fallback_type === 'number') {
            value = Number(fb);
          } else {
            value = fb;
          }
        }

        output[key] = value;
      } else {
        output[key] = config;
      }
    }
    return output;
  }

  private matchesCondition(
    val: unknown,
    op: string,
    compareVal: unknown,
  ): boolean {
    if (op === 'is_empty_array') {
      return Array.isArray(val) && val.length === 0;
    }
    if (op === 'is_not_empty_array') {
      return Array.isArray(val) && val.length > 0;
    }
    if (op === 'is_empty') {
      return (
        val === null ||
        val === undefined ||
        val === '' ||
        (Array.isArray(val) && val.length === 0) ||
        (typeof val === 'object' && Object.keys(val as object).length === 0)
      );
    }
    if (op === 'is_not_empty') {
      return (
        val !== null &&
        val !== undefined &&
        val !== '' &&
        (!Array.isArray(val) || val.length > 0)
      );
    }

    if (val === null || val === undefined) return false;

    if (
      op === '==' &&
      Array.isArray(val) &&
      (compareVal === '[]' || compareVal === '')
    ) {
      return val.length === 0;
    }
    if (
      op === '!=' &&
      Array.isArray(val) &&
      (compareVal === '[]' || compareVal === '')
    ) {
      return val.length > 0;
    }

    const numVal = Number(val);
    const numRule = Number(compareVal);
    const shouldCompareAsNumber =
      !isNaN(numVal) && !isNaN(numRule) && String(compareVal).trim() !== '';
    const valToCompare: string | number = shouldCompareAsNumber
      ? numVal
      : String(val).trim();
    const ruleVal: string | number = shouldCompareAsNumber
      ? numRule
      : String(compareVal).trim();

    switch (op) {
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
        if (Array.isArray(val)) {
          return val.includes(compareVal);
        }
        return String(valToCompare).includes(String(ruleVal));
      default:
        return false;
    }
  }

  private evaluateComparisonRules(
    value: unknown,
    rules: Array<{
      operator?: string;
      compare_value?: string;
      return_value: unknown;
      return_type?: string;
      logic?: string;
      conditions?: Array<{
        path?: string;
        operator: string;
        compare_value: string;
      }>;
    }>,
    rootRaw?: unknown,
  ): { value: unknown; matched: boolean } {
    if (!rules || !rules.length) return { value, matched: false };

    for (const rule of rules) {
      const { operator, compare_value, return_type, logic, conditions } =
        rule as any;
      let return_value = rule.return_value;

      if (return_type === 'path') {
        return_value = this.getByPath(rootRaw, String(return_value));
      } else if (
        return_type === 'boolean' ||
        return_value === true ||
        return_value === false ||
        return_value === 'true' ||
        return_value === 'false'
      ) {
        return_value = return_value === true || return_value === 'true';
      } else if (return_type === 'number') {
        const num = Number(return_value);
        if (!isNaN(num)) return_value = num;
      }

      if (Array.isArray(conditions) && conditions.length > 0) {
        const logOp = logic === 'or' ? 'or' : 'and';
        const evalCond = (c: any) => {
          const targetVal = c.path ? this.getByPath(rootRaw, c.path) : value;
          return this.matchesCondition(targetVal, c.operator, c.compare_value);
        };

        const isMatch =
          logOp === 'or'
            ? conditions.some(evalCond)
            : conditions.every(evalCond);

        if (isMatch) return { value: return_value, matched: true };
        continue;
      }

      if (this.matchesCondition(value, operator, compare_value)) {
        return { value: return_value, matched: true };
      }
    }

    return { value, matched: false };
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
              // Retorna imediatamente o array mapeado: continuar o loop
              // tentaria acessar [key] sobre a lista e sobrescreveria o
              // resultado com undefined/null.
              return current
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

  parseToolArguments(raw: unknown): Record<string, unknown> {
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
}
