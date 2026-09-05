import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';
import { resolveChainedApiId } from '../common/utils/api-chaining.util';
import { LEGACY_TOOL_NAMES } from '../orchestrator/constants/tools.constants';
import { validateWebhookUrl } from '../common/utils/ssrf-guard';

const TOOLS_CACHE_TTL_SECONDS = 30;

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

    return apis.map((api) => ({
      id: api.id,
      apiName: api.name,
      name: this.toFunctionName(api.name, api.id),
      description:
        api.description ||
        `Executa a API "${api.name}" e retorna os dados encontrados.`,
      parameters: this.buildParameters(api),
      method: api.method,
      url: api.url,
      headers: api.headers,
      body: api.body,
      extract_data: api.extract_data,
    }));
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
  ) {
    const tool = (await this.getAgentTools(clientId, agentId)).find(
      (candidate) => candidate.name === functionName,
    );
    if (!tool) {
      return {
        ok: false,
        error: `Tool ${functionName} nao encontrada para este agente.`,
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      const raw = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

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
      const hasExtractConfig =
        extractConfig &&
        typeof extractConfig === 'object' &&
        Object.keys(extractConfig).filter(
          (k) =>
            ![
              '_fallback_message',
              'fallback_message',
              'validate_field',
            ].includes(k),
        ).length > 0;

      let consolidatedData: Record<string, unknown> = {};
      if (hasExtractConfig && extracted && typeof extracted === 'object') {
        consolidatedData = { ...extracted };
      } else if (raw && typeof raw === 'object') {
        consolidatedData = { ...(raw as Record<string, unknown>) };
      }

      // Encadeamento: regras condicionais (_chaining) ou direto (next_api_id/next_tool)
      const legacyNextApiId =
        (headers.next_api_id as string) || (tool as any).next_tool;
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
          try {
            const nextApi = await this.prisma.painel_apis.findFirst({
              where: {
                OR: [{ id: nextApiId }, { name: nextApiId }],
                active: true,
                client_id: clientId,
              },
            });
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
                this.toFunctionName(nextApi.name, nextApi.id),
                nextArgs,
                sessionState,
                nextVisited,
              );
              if (nextResult && nextResult.ok) {
                consolidatedData = {
                  ...consolidatedData,
                  ...nextResult,
                  tem_ofertas: true,
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
    const response = await fetch(
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
        // "Dado de Outra API / Sessão": resolve na ordem estado da sessão ->
        // argumentos da IA. Se nada for encontrado, o campo é OMITIDO
        // (nunca enviar o nome da variável literal como valor).
        const varName =
          typeof config.value === 'string'
            ? config.value.replace(/[{}]/g, '').trim()
            : '';
        const keyLower = key.toLowerCase();
        const isCpfField =
          varName.toLowerCase().includes('cpf') || keyLower.includes('cpf');
        resolved =
          this.lookupSessionValue(sessionState, varName) ??
          this.lookupSessionValue(sessionState, key) ??
          (isCpfField
            ? this.lookupSessionValue(sessionState, 'cliente_cpf')
            : undefined) ??
          (args as any)[varName] ??
          (args as any)[key] ??
          (args as any)['cliente_cpf'] ??
          (args as any)['cpf'];
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
    if (!keys.length || !raw || typeof raw !== 'object') return raw;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const config = mapping[key];
      if (typeof config === 'boolean' || typeof config === 'number') {
        result[key] = config;
      } else if (typeof config === 'string') {
        result[key] = this.getByPath(raw, config);
      } else if (config && typeof config === 'object' && 'path' in config) {
        const cfg = config as any;
        let value = this.getByPath(raw, String(cfg.path || ''));
        let matchedRule = false;
        if (cfg.rules?.length) {
          const res = this.evaluateComparisonRules(value, cfg.rules, raw);
          value = res.value;
          matchedRule = res.matched;
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
          const fb = cfg.fallback;
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
        result[key] = value;
      } else {
        result[key] = config;
      }
    }
    return result;
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
    const direct = path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);

    if (direct !== undefined && direct !== null) return direct;

    if (
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      !path.startsWith('data.')
    ) {
      return path.split('.').reduce<unknown>(
        (current, key) => {
          if (!current || typeof current !== 'object') return undefined;
          return (current as Record<string, unknown>)[key];
        },
        (value as any).data,
      );
    }

    return undefined;
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

  private setDeepValue(
    target: Record<string, unknown>,
    path: string,
    value: unknown,
  ) {
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
