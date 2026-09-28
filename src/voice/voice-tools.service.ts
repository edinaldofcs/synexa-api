import { applyExtractModifier } from '../common/utils/api-extraction.util';
import { validateExtraction } from '../common/utils/extraction-validation.util';
import {
  readExtractionPath,
  isSafePath,
  readVariable,
  variableKey,
  businessVariables,
  savedRequestVariables,
} from '../common/utils/session-variables.util';
import { publicFetch } from '../common/utils/public-http';
import {
  startHttpAudit,
  type HttpToolAudit,
} from './services/voice-tool-audit';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';
import { resolveChainedApiId } from '../common/utils/api-chaining.util';
import { LEGACY_TOOL_NAMES } from '../orchestrator/constants/tools.constants';
import { validateWebhookUrl } from '../common/utils/ssrf-guard';

const TOOLS_CACHE_TTL_SECONDS = 30;

/** UUID shape used to validate configured API targets. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoiceToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface VoiceTool extends VoiceToolDeclaration {
  id: string;
  apiName: string;
  method?: string | null;
  url?: string | null;
  headers?: unknown;
  body?: unknown;
  extract_data?: unknown;
}

@Injectable()
export class VoiceToolsService {
  private readonly logger = new Logger(VoiceToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
    private readonly redis: RedisService,
  ) {}

  async getAgentTools(clientId: string, agentId: string): Promise<VoiceTool[]> {
    const cacheKey = `voice:tools:${clientId}:${agentId}`;
    try {
      const cached = await this.redis.get<VoiceTool[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache indisponível: segue com consulta ao banco
    }
    const tools = await this.loadAgentTools(clientId, agentId);
    try {
      await this.redis.set(cacheKey, tools, TOOLS_CACHE_TTL_SECONDS);
    } catch {
      // Sem cache: segue o fluxo
    }
    return tools;
  }

  private async loadAgentTools(
    clientId: string,
    agentId: string,
  ): Promise<VoiceTool[]> {
    const agent = await this.prisma.painel_agents.findFirst({
      where: { id: agentId, client_id: clientId },
      select: { allowed_tool_names: true },
    });
    if (!agent) return [];

    const allowedNames = Array.isArray(agent.allowed_tool_names)
      ? agent.allowed_tool_names.filter(
          (name: unknown): name is string => typeof name === 'string',
        )
      : [];
    const where: Record<string, unknown> = {
      client_id: clientId,
      active: true,
      visible_to_agent: true,
    };
    const customToolNames = allowedNames.filter(
      (name) => !LEGACY_TOOL_NAMES.has(name),
    );
    if (customToolNames.length > 0) {
      where.name = { in: customToolNames };
    } else {
      where.agent_id = agentId;
    }

    const apis = await this.prisma.painel_apis.findMany({
      where: where as any,
      orderBy: { execution_order: 'asc' },
    });

    // Nomes de tool únicos por cliente (slug puro, sem UUID). O LLM chama
    // pelo nome amigável; duplicados recebem sufixo numérico.
    const takenNames = new Set<string>();
    return apis.map((api) => ({
      id: api.id,
      apiName: api.name,
      name:
        api.function_name || this.toFunctionName(api.name, api.id, takenNames),
      description:
        api.description ||
        `Executa a API "${api.name}" e retorna os dados encontrados.`,
      parameters: this.buildParameters(api),
      method: api.method,
      url: api.url,
      headers: api.headers,
      body: api.body,
      extract_data: api.extract_data,
      next_api_id: this.resolveNextApiId(api as any),
    }));
  }

  /** Read the explicit chain target from the API configuration. */
  private resolveNextApiId(api: Record<string, any>): string | null {
    const meta = this.asRecord(api.config);
    const candidates = [(api as any).next_api_id, meta.next_api_id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
    }
    return null;
  }

  async getAgentSubagents(
    clientId: string,
    agentId: string,
  ): Promise<VoiceToolDeclaration[]> {
    const subagents = await this.findAllowedSubagents(clientId, agentId);
    return subagents.map((subagent) => ({
      name: this.toSubagentFunctionName(subagent.name),
      description:
        `[SUBAGENTE ESPECIALISTA: ${subagent.name.toUpperCase()}] ${subagent.description}. ` +
        'Acione esta ferramenta para delegar uma tarefa especializada.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Instrucao ou pergunta detalhada para o subagente.',
          },
          context_data: {
            type: 'string',
            description: 'Dados adicionais relevantes para a tarefa.',
          },
        },
        required: ['task'],
      },
    }));
  }

  async execute(
    clientId: string,
    agentId: string,
    functionName: string,
    args: Record<string, unknown>,
    sessionState?: Record<string, unknown>,
    visited?: Set<string>,
    audit?: HttpToolAudit[],
    parentAuditId?: string,
  ) {
    let tool = (await this.getAgentTools(clientId, agentId)).find(
      (candidate) => candidate.name === functionName,
    );
    if (!tool) {
      // Se não encontrou entre as ferramentas diretas do agente (ex: é uma API FILHA interna de encadeamento),
      // busca no catálogo geral de APIs do cliente
      const allApis = await this.prisma.painel_apis.findMany({
        where: { client_id: clientId, active: true },
      });
      // Legado: nomes no formato antigo `slug_uuid` (sessões em andamento
      // e caches) continuam resolvendo — comparo o prefixo antes do UUID.
      const legacySlug = functionName
        .toLowerCase()
        .replace(/_[0-9a-f]{8}(_[0-9a-f]{4}){3}_[0-9a-f]{12}$/i, '')
        .replace(/_+$/, '');
      const dbApi = allApis.find((a) => {
        const fn = a.function_name || this.toFunctionName(a.name, a.id);
        return (
          fn === functionName ||
          a.id === functionName ||
          a.name.toLowerCase().trim() === functionName.toLowerCase().trim() ||
          a.name === functionName ||
          (legacySlug && legacySlug === fn) ||
          (legacySlug &&
            legacySlug ===
              a.name
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-zA-Z0-9_-]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .toLowerCase())
        );
      });
      if (dbApi) {
        tool = {
          id: dbApi.id,
          apiName: dbApi.name,
          name:
            dbApi.function_name || this.toFunctionName(dbApi.name, dbApi.id),
          description: dbApi.description || '',
          parameters: this.buildParameters(dbApi),
          method: dbApi.method,
          url: dbApi.url,
          headers: dbApi.headers,
          body: dbApi.body,
          extract_data: dbApi.extract_data,
          next_api_id: this.resolveNextApiId(dbApi as any),
        } as any;
      }
    }
    if (!tool) {
      return {
        ok: false,
        error: `Tool ${functionName} nao encontrada para este cliente/agente.`,
      };
    }
    if (!tool.url) {
      return { ok: false, error: `Tool ${tool.apiName} sem URL configurada.` };
    }

    let url = tool.url;
    for (const parameter of this.extractUrlParams(url)) {
      const value =
        args[parameter] ?? this.lookupSessionValue(sessionState, parameter);
      if (value === undefined || value === null || value === '') {
        return {
          ok: false,
          error: `Parametro obrigatorio ausente: ${parameter}`,
        };
      }
      url = url.replace(`{${parameter}}`, encodeURIComponent(String(value)));
    }

    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        error:
          'URL da ferramenta inválida. Deve iniciar com http:// ou https://',
      };
    }

    try {
      await validateWebhookUrl(url, process.env.ENVIRONMENT === 'development');
    } catch (err: any) {
      return {
        ok: false,
        error: `URL bloqueada por segurança (SSRF): ${err.message}`,
      };
    }

    const method = (tool.method || 'GET').toUpperCase();
    const headers = this.asRecord(tool.headers) as Record<string, string>;
    const init: RequestInit = { method, headers };
    const body = this.buildBody(tool.body, args, sessionState);
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
      init.body = JSON.stringify(body);
      if (
        !Object.keys(headers).some(
          (key) => key.toLowerCase() === 'content-type',
        )
      ) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const sentVariables = savedRequestVariables(
      tool.body,
      init.body ? body : undefined,
    );
    sessionState ??= {};
    Object.assign(sessionState, sentVariables);

    const controller = new AbortController();
    const capture = audit
      ? startHttpAudit({
          apiId: tool.id,
          name: tool.apiName,
          url,
          method,
          headers,
          body: init.body ? body : null,
          parentId: parentAuditId,
        })
      : undefined;
    if (capture) audit!.push(capture.entry);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await publicFetch(url, {
        ...init,
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      const rawText = await response.text();
      // Preserve evidence even when an upstream server sends invalid JSON.
      capture?.response(response.status, response.headers, rawText);
      const raw = contentType.includes('application/json')
        ? JSON.parse(rawText)
        : rawText;
      capture?.response(response.status, response.headers, raw);

      const extractConfig = tool.extract_data as
        | Record<string, any>
        | undefined;
      const fallbackMessage =
        extractConfig?._fallback_message ||
        extractConfig?.fallback_message ||
        tool.description ||
        'Não foram encontrados dados ou a consulta falhou no momento.';

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: fallbackMessage,
        };
      }

      const extracted = this.applyExtractData(raw, tool.extract_data);
      capture?.extracted(extracted);
      const hasExtractConfig =
        extractConfig &&
        typeof extractConfig === 'object' &&
        Object.keys(extractConfig).filter(
          (k) =>
            ![
              '_fallback_message',
              'fallback_message',
              'validate_field',
              '_chaining',
            ].includes(k),
        ).length > 0;

      // HTTP 200 is transport success, not evidence that the mapped data exists.
      // Undefined properties disappear during JSON serialization and used to leave
      // only { ok: true, status: 200 }, causing the model to assume a successful lookup.
      if (!this.hasExtractionData(hasExtractConfig ? extracted : raw)) {
        return {
          ok: false,
          status: response.status,
          error: 'extraction_empty',
          message: fallbackMessage,
        };
      }
      let consolidatedData: Record<string, unknown> = { ...sentVariables };
      if (hasExtractConfig && extracted && typeof extracted === 'object') {
        Object.assign(consolidatedData, businessVariables(extracted));
      } else if (raw && typeof raw === 'object') {
        Object.assign(consolidatedData, businessVariables(raw));
      }

      if (sessionState) Object.assign(sessionState, consolidatedData);

      const chainTrail: Array<{
        from: string;
        fromId: string;
        to: string;
        toId: string;
        arguments: Record<string, unknown>;
        response: Record<string, unknown>;
        timestamp: string;
      }> = [];

      // Encadeamento: regras condicionais (_chaining) ou direto (next_api_id)
      const legacyNextApiId = (tool as any).next_api_id;
      const nextApiId = resolveChainedApiId(
        tool.extract_data,
        consolidatedData,
        legacyNextApiId,
      );
      if (response.ok && nextApiId) {
        const chainVisited =
          visited ?? new Set<string>([tool.id, tool.apiName].filter(Boolean));
        if (chainVisited.has(nextApiId)) {
          this.logger.warn(
            `Ciclo detectado no encadeamento de APIs de voz (${nextApiId}); cadeia abortada`,
          );
        } else {
          this.logger.log(
            `🔗 [VoiceTools] Encadeamento resolvido: ${tool.apiName} ➔ ${nextApiId}`,
          );
          try {
            // O filtro `id` do Prisma é UUID: passar um nome legado
            // (por exemplo, "offers") lança P2023 e aborta a cadeia em
            // silêncio. O filtro por id só entra quando o valor tem forma
            // de UUID; nomes resolvem apenas por `name`.
            const isUuidValue = UUID_SHAPE.test(nextApiId.trim());
            const nextApi = await this.prisma.painel_apis.findFirst({
              where: {
                ...(isUuidValue
                  ? { OR: [{ id: nextApiId }, { name: nextApiId }] }
                  : { name: nextApiId }),
                active: true,
                client_id: clientId,
              },
            });
            if (!nextApi) {
              this.logger.warn(
                `API encadeada não encontrada no catálogo do cliente (${nextApiId}); cadeia abortada`,
              );
            }
            if (nextApi) {
              const nextArgs = {
                ...args,
                ...consolidatedData,
              };
              const nextVisited = new Set(chainVisited);
              nextVisited.add(nextApi.id);
              const nextResult = await this.execute(
                clientId,
                agentId,
                nextApi.function_name ||
                  this.toFunctionName(nextApi.name, nextApi.id),
                nextArgs,
                sessionState,
                nextVisited,
                audit,
                capture?.entry.id,
              );
              if (nextResult) {
                const { _chainTrail: nestedTrail, ...childResponse } =
                  nextResult as Record<string, unknown>;
                if (Array.isArray(nestedTrail)) {
                  chainTrail.push(...nestedTrail);
                }
                chainTrail.unshift({
                  from: tool.apiName,
                  fromId: tool.id,
                  to: nextApi.name,
                  toId: nextApi.id,
                  arguments: nextArgs,
                  response: childResponse,
                  timestamp: new Date().toISOString(),
                });
                // Keep failed executions visible and propagate the failing tool's
                // fallback through every parent instead of reporting root success.
                if (nextResult.ok === false) {
                  return {
                    ...consolidatedData,
                    ...childResponse,
                    ok: false,
                    _chainTrail: chainTrail,
                  };
                }
                consolidatedData = {
                  ...consolidatedData,
                  ...childResponse,
                };
              }
            }
          } catch (chainErr) {
            this.logger.warn(
              `Falha ao executar API encadeada no canal de voz (${nextApiId}): ${chainErr}`,
            );
          }
        }
      }

      if (chainTrail.length > 0) {
        consolidatedData._chainTrail = chainTrail;
      }

      if (Object.keys(consolidatedData).length > 0) {
        return {
          ok: true,
          status: response.status,
          ...consolidatedData,
        };
      }

      return {
        ok: true,
        status: response.status,
        resultado: raw ?? fallbackMessage,
      };
    } catch (error) {
      capture?.failed(error);
      const extractConfig = tool.extract_data as
        | Record<string, any>
        | undefined;
      const fallbackMessage =
        extractConfig?._fallback_message ||
        extractConfig?.fallback_message ||
        'Falha na comunicação com o serviço no momento.';
      return {
        ok: false,
        message: fallbackMessage,
        error: error instanceof Error ? error.message : 'Falha ao executar API',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async executeSubagent(
    clientId: string,
    agentId: string,
    functionName: string,
    args: Record<string, unknown>,
  ) {
    const subagent = (await this.findAllowedSubagents(clientId, agentId)).find(
      (candidate) =>
        this.toSubagentFunctionName(candidate.name) === functionName,
    );
    if (!subagent) {
      return {
        ok: false,
        error: `Subagente ${functionName} nao autorizado para este agente.`,
      };
    }

    const provider = (subagent.llm_provider || 'gemini').toLowerCase();
    if (provider !== 'gemini') {
      return {
        ok: false,
        error: `Provedor ${provider} nao suportado para subagentes de voz.`,
      };
    }

    const apiKey = await this.providerKeyResolver.resolveApiKey(
      clientId,
      provider,
    );
    if (!apiKey) {
      return {
        ok: false,
        error: 'Chave Gemini nao configurada para o subagente.',
      };
    }

    const task =
      typeof args.task === 'string'
        ? args.task
        : JSON.stringify(args.task || '');
    const contextData =
      typeof args.context_data === 'string'
        ? args.context_data
        : args.context_data
          ? JSON.stringify(args.context_data)
          : 'Nenhum dado adicional fornecido.';
    const model = subagent.model || 'gemini-2.0-flash-lite';
    const response = await publicFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: subagent.system_prompt }] },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `[TAREFA DELEGADA PELO AGENTE DE VOZ]\n${task}\n\n[DADOS DE CONTEXTO]\n${contextData}`,
                },
              ],
            },
          ],
          generationConfig: { temperature: subagent.temperature ?? 0.7 },
        }),
      },
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error?.message || `Erro Gemini ${response.status}`,
      };
    }

    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || '')
      .join('')
      .trim();
    return {
      ok: true,
      status: response.status,
      data: {
        status: 'completed',
        subagent: subagent.name,
        response: text || 'Sem resposta do subagente.',
      },
    };
  }

  private async findAllowedSubagents(clientId: string, agentId: string) {
    const cacheKey = `voice:tools:subagents:${clientId}:${agentId}`;
    try {
      const cached = await this.redis.get<Array<Record<string, any>>>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache indisponível: segue com consulta ao banco
    }
    const subagents = await this.loadAllowedSubagents(clientId, agentId);
    try {
      await this.redis.set(cacheKey, subagents, TOOLS_CACHE_TTL_SECONDS);
    } catch {
      // Sem cache: segue o fluxo
    }
    return subagents;
  }

  private async loadAllowedSubagents(clientId: string, agentId: string) {
    const agent = await this.prisma.painel_agents.findFirst({
      where: { id: agentId, client_id: clientId },
      select: { transitions: true },
    });
    const transitions = this.asRecord(agent?.transitions);
    const allowed = Array.isArray(transitions.allowed_subagents)
      ? transitions.allowed_subagents
      : Array.isArray(transitions.allowed_subagent_ids)
        ? transitions.allowed_subagent_ids
        : [];
    const values = allowed.filter(
      (value): value is string => typeof value === 'string',
    );
    if (!values.length) return [];

    const isUuid = (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      );
    const ids = values.filter(isUuid);
    const names = values.filter((value) => !isUuid(value));
    const conditions: Array<Record<string, unknown>> = [];
    if (ids.length) conditions.push({ id: { in: ids } });
    if (names.length) conditions.push({ name: { in: names } });

    return this.prisma.painel_subagents.findMany({
      where: {
        client_id: clientId,
        is_active: true,
        OR: conditions,
      },
      select: {
        id: true,
        name: true,
        description: true,
        system_prompt: true,
        llm_provider: true,
        model: true,
        temperature: true,
      },
    });
  }

  private buildParameters(api: {
    url?: string | null;
    body?: unknown;
    parameters?: unknown;
  }): Record<string, unknown> {
    const schema = this.asRecord(api.parameters);
    if (schema.type === 'object' && schema.properties) {
      return {
        type: 'object',
        properties: this.asRecord(schema.properties),
        required: Array.isArray(schema.required) ? schema.required : [],
      };
    }

    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    for (const parameter of this.extractUrlParams(api.url || '')) {
      properties[parameter] = { type: 'string' };
      required.add(parameter);
    }
    for (const [key, value] of Object.entries(this.asRecord(api.body))) {
      const config = this.asRecord(value);
      if (config.source === 'ai') {
        properties[key] = {
          type: config.type === 'boolean' ? 'boolean' : 'string',
          description: config.value || `Valor de ${key}`,
        };
        required.add(key);
      }
    }
    return {
      type: 'object',
      properties,
      required: [...required],
    };
  }

  private buildBody(
    bodyValue: unknown,
    args: Record<string, unknown>,
    sessionState?: Record<string, unknown>,
  ) {
    const body = this.asRecord(bodyValue);
    if (!Object.keys(body).length) return undefined;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      const config = this.asRecord(value);
      let resolved: unknown;
      if (config.source === 'null' || config.type === 'null') {
        resolved = null;
      } else if (config.source === 'ai') {
        resolved = args[key];
        if (resolved === undefined && key.includes('.')) {
          resolved = args[key.split('.').pop()!];
        }
        if (resolved === undefined) {
          resolved = this.lookupSessionValue(sessionState, key);
        }
      } else if (config.source === 'system') {
        const source = typeof config.value === 'string' ? config.value : '';
        resolved = readVariable(sessionState, source);
        if (
          (resolved === undefined || resolved === null || resolved === '') &&
          config.required === true
        ) {
          throw new Error('SESSION_VARIABLE_REQUIRED: ' + source);
        }
      } else if ('value' in config) {
        const rawVal = config.value;
        if (
          typeof rawVal === 'string' &&
          rawVal.startsWith('{{') &&
          rawVal.endsWith('}}')
        ) {
          const varName = rawVal.replace(/[{}]/g, '').trim();
          resolved =
            (args as any)[varName] ??
            (args as any)[key] ??
            this.lookupSessionValue(sessionState, varName) ??
            rawVal;
        } else {
          resolved = rawVal;
        }
      } else {
        resolved = value;
      }

      if (
        config.type === 'number' &&
        resolved !== undefined &&
        resolved !== null
      ) {
        const numeric = Number(resolved);
        if (!Number.isNaN(numeric)) resolved = numeric;
      }
      if (config.type === 'boolean') {
        resolved =
          resolved === true ||
          resolved === 'true' ||
          resolved === 1 ||
          resolved === '1';
      }
      this.setDeepValue(output, key, resolved);
    }
    return output;
  }

  private applyExtractData(raw: unknown, extractData: unknown) {
    validateExtraction(extractData);
    const mapping = this.asRecord(extractData);
    const keys = Object.keys(mapping).filter(
      (k) =>
        ![
          '_fallback_message',
          'fallback_message',
          'validate_field',
          '_chaining',
        ].includes(k),
    );
    if (!keys.length) return raw;
    const result: Record<string, unknown> = {};
    for (const rawKey of keys) {
      const key = variableKey(rawKey);
      const config = mapping[rawKey];
      if (typeof config === 'boolean' || typeof config === 'number') {
        result[key] = config;
      } else if (typeof config === 'string') {
        result[key] = this.getByPath(raw, config);
      } else if (
        config &&
        typeof config === 'object' &&
        'value' in config &&
        !('path' in config)
      ) {
        result[key] = (config as any).value;
      } else if (config && typeof config === 'object' && 'path' in config) {
        const cfg = config as any;
        let value = this.getByPath(raw, String(cfg.path || ''));
        if (Array.isArray(value) && cfg.max_items > 0)
          value = value.slice(0, cfg.max_items);
        let matchedRule = false;
        if (cfg.rules?.length) {
          const res = this.evaluateComparisonRules(value, cfg.rules, raw);
          value = res.value;
          matchedRule = res.matched;
        }

        if (cfg.modifier && (!cfg.rules?.length || matchedRule))
          value = applyExtractModifier(value, cfg.modifier);
        const isMissing = value === null || value === undefined || value === '';
        const ruleFailedWithFallback =
          Boolean(cfg.rules?.length) &&
          !matchedRule &&
          cfg.fallback !== undefined;

        if (
          (isMissing || ruleFailedWithFallback) &&
          cfg.fallback !== undefined
        ) {
          const fb = cfg.fallback;
          if (cfg.fallback_type === 'path') {
            value = this.getByPath(raw, String(fb));
          } else if (cfg.fallback_type === 'boolean') {
            value = fb === true || fb === 'true';
          } else if (cfg.fallback_type === 'number') {
            value = Number(fb);
          } else if (cfg.fallback_type === 'string') {
            value = String(fb ?? '');
          } else {
            // legacy fallback when fallback_type is not provided
            if (
              fb === true ||
              fb === false ||
              fb === 'true' ||
              fb === 'false'
            ) {
              value = fb === true || fb === 'true';
            } else {
              value = fb;
            }
          }
        }
        result[key] = value;
      } else {
        result[key] = config;
      }
    }
    return result;
  }

  private hasExtractionData(value: unknown): boolean {
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (item === null || item === undefined) continue;
      if (typeof item === 'string') {
        if (item.trim()) return true;
      } else if (typeof item === 'object') {
        for (const child of Object.values(item)) pending.push(child);
      } else return true; // 0 and false are valid extracted values.
    }
    return false;
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
      typeof val === 'boolean' &&
      (compareVal === 'true' || compareVal === 'false') &&
      (op === '==' || op === '!=')
    ) {
      const equal = val === (compareVal === 'true');
      return op === '==' ? equal : !equal;
    }

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
      } else if (return_type === 'boolean') {
        return_value = return_value === true || return_value === 'true';
      } else if (return_type === 'number') {
        const num = Number(return_value);
        if (!isNaN(num)) return_value = num;
      } else if (return_type === 'string') {
        return_value = String(return_value ?? '');
      } else {
        // legacy fallback when return_type is not provided
        if (
          return_value === true ||
          return_value === false ||
          return_value === 'true' ||
          return_value === 'false'
        ) {
          return_value = return_value === true || return_value === 'true';
        }
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
    return readExtractionPath(value, path);
  }

  private lookupSessionValue(
    state: Record<string, unknown> | undefined,
    path: string,
  ): unknown {
    return readVariable(state, path);
  }

  private setDeepValue(
    target: Record<string, unknown>,
    path: string,
    value: unknown,
  ) {
    if (!isSafePath(path)) throw new Error('INVALID_PATH');
    const parts = path.split('.');
    let current = target;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current[part] = value;
        return;
      }
      if (!current[part] || typeof current[part] !== 'object')
        current[part] = {};
      current = current[part] as Record<string, unknown>;
    });
  }

  private extractUrlParams(url: string) {
    return [...url.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
  }

  /**
   * Nome da function declarada ao LLM: slug do nome da API, único por
   * cliente (nomes duplicados ganham sufixo numérico: offers, offers_2).
   * Sem UUID no nome — muito mais natural para o agente chamar.
   * A resolução reverse (functionName -> API) aceita o nome da API e o
   * slug, mantendo compatibilidade com tools legadas com UUID.
   */
  private toFunctionName(name: string, id: string, taken?: Set<string>) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
      .toLowerCase();
    const base = slug || 'tool';
    if (!taken) return base;
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    let n = 2;
    while (taken.has(`${base}_${n}`)) n++;
    const unique = `${base}_${n}`;
    taken.add(unique);
    return unique;
  }

  private toSubagentFunctionName(name: string) {
    const clean = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '');
    return `subagent_${clean || 'tool'}`;
  }

  private asRecord(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }
}
