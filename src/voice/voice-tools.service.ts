import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';

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
  ) {}

  async getAgentTools(
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
      (name) => !['execute_api', 'search_knowledge_base', 'search_web'].includes(name),
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
        api.description || `Executa a API "${api.name}" e retorna os dados encontrados.`,
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
  ) {
    const tool = (await this.getAgentTools(clientId, agentId)).find(
      (candidate) => candidate.name === functionName,
    );
    if (!tool) {
      return { ok: false, error: `Tool ${functionName} nao encontrada para este agente.` };
    }
    if (!tool.url) {
      return { ok: false, error: `Tool ${tool.apiName} sem URL configurada.` };
    }

    let url = tool.url;
    for (const parameter of this.extractUrlParams(url)) {
      const value = args[parameter];
      if (value === undefined || value === null || value === '') {
        return { ok: false, error: `Parametro obrigatorio ausente: ${parameter}` };
      }
      url = url.replace(`{${parameter}}`, encodeURIComponent(String(value)));
    }

    const method = (tool.method || 'GET').toUpperCase();
    const headers = this.asRecord(tool.headers) as Record<string, string>;
    const init: RequestInit = { method, headers };
    const body = this.buildBody(tool.body, args);
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
      init.body = JSON.stringify(body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
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

      const extractConfig = tool.extract_data as Record<string, any> | undefined;
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
          (k) => !['_fallback_message', 'fallback_message', 'validate_field'].includes(k),
        ).length > 0;

      let consolidatedData: Record<string, unknown> = {};
      if (hasExtractConfig && extracted && typeof extracted === 'object') {
        consolidatedData = { ...extracted };
      } else if (raw && typeof raw === 'object') {
        consolidatedData = { ...(raw as Record<string, unknown>) };
      }

      // Suporte a API encadeada (next_api_id ou next_tool)
      const nextApiId = (headers.next_api_id as string) || (tool as any).next_tool;
      if (response.ok && nextApiId) {
        try {
          const nextApi = await this.prisma.painel_apis.findFirst({
            where: {
              OR: [
                { id: nextApiId },
                { name: nextApiId },
              ],
              active: true,
            },
          });
          if (nextApi) {
            const nextArgs = {
              ...args,
              ...consolidatedData,
            };
            const nextResult = await this.execute(
              clientId,
              agentId,
              this.toFunctionName(nextApi.name, nextApi.id),
              nextArgs,
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
          this.logger.warn(`Falha ao executar API encadeada no canal de voz (${nextApiId}): ${chainErr}`);
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
      const extractConfig = tool.extract_data as Record<string, any> | undefined;
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
      (candidate) => this.toSubagentFunctionName(candidate.name) === functionName,
    );
    if (!subagent) {
      return { ok: false, error: `Subagente ${functionName} nao autorizado para este agente.` };
    }

    const provider = (subagent.llm_provider || 'gemini').toLowerCase();
    if (provider !== 'gemini') {
      return { ok: false, error: `Provedor ${provider} nao suportado para subagentes de voz.` };
    }

    const apiKey = await this.providerKeyResolver.resolveApiKey(clientId, provider);
    if (!apiKey) {
      return { ok: false, error: 'Chave Gemini nao configurada para o subagente.' };
    }

    const task = typeof args.task === 'string' ? args.task : JSON.stringify(args.task || '');
    const contextData = typeof args.context_data === 'string'
      ? args.context_data
      : args.context_data
        ? JSON.stringify(args.context_data)
        : 'Nenhum dado adicional fornecido.';
    const model = subagent.model || 'gemini-2.5-flash-lite';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: subagent.system_prompt }] },
          contents: [{
            role: 'user',
            parts: [{
              text: `[TAREFA DELEGADA PELO AGENTE DE VOZ]\n${task}\n\n[DADOS DE CONTEXTO]\n${contextData}`,
            }],
          }],
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
    const values = allowed.filter((value): value is string => typeof value === 'string');
    if (!values.length) return [];

    const isUuid = (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

  private buildBody(bodyValue: unknown, args: Record<string, unknown>) {
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
      } else if (config.source === 'system') {
        const varName = typeof config.value === 'string' ? config.value.replace(/[{}]/g, '').trim() : '';
        resolved = (args as any)[varName] ?? (args as any)[key] ?? (args as any)['cliente_cpf'] ?? (args as any)['cpf'] ?? config.value;
      } else if ('value' in config) {
        const rawVal = config.value;
        if (typeof rawVal === 'string' && rawVal.startsWith('{{') && rawVal.endsWith('}}')) {
          const varName = rawVal.replace(/[{}]/g, '').trim();
          resolved = (args as any)[varName] ?? (args as any)[key] ?? rawVal;
        } else {
          resolved = rawVal;
        }
      } else {
        resolved = value;
      }

      if (config.type === 'number' && resolved !== undefined && resolved !== null) {
        const numeric = Number(resolved);
        if (!Number.isNaN(numeric)) resolved = numeric;
      }
      if (config.type === 'boolean') {
        resolved = resolved === true || resolved === 'true' || resolved === 1 || resolved === '1';
      }
      this.setDeepValue(output, key, resolved);
    }
    return output;
  }

  private applyExtractData(raw: unknown, extractData: unknown) {
    const mapping = this.asRecord(extractData);
    const keys = Object.keys(mapping).filter(
      (k) => !['_fallback_message', 'fallback_message', 'validate_field'].includes(k),
    );
    if (!keys.length || !raw || typeof raw !== 'object') return raw;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const path = mapping[key];
      if (typeof path === 'string') result[key] = this.getByPath(raw, path);
      else if (path && typeof path === 'object' && 'path' in path) {
        result[key] = this.getByPath(raw, String((path as { path: unknown }).path));
      }
    }
    return result;
  }

  private getByPath(value: unknown, path: string): unknown {
    const direct = path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);

    if (direct !== undefined && direct !== null) return direct;

    if (typeof value === 'object' && value !== null && 'data' in value && !path.startsWith('data.')) {
      return path.split('.').reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object') return undefined;
        return (current as Record<string, unknown>)[key];
      }, (value as any).data);
    }

    return undefined;
  }

  private setDeepValue(target: Record<string, unknown>, path: string, value: unknown) {
    const parts = path.split('.');
    let current = target;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current[part] = value;
        return;
      }
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
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
    return `subagent_${name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
  }

  private asRecord(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }
}
