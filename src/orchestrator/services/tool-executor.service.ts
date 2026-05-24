import { Injectable, Logger } from '@nestjs/common';
import { sanitize } from '../../common/utils/sanitize-log.util';
import { extractDataFromResponse } from '../utils/deep-search.util';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  'host.docker.internal',
  'metadata.google.internal',
  '169.254.169.254',
]);

@Injectable()
export class OrchestratorToolExecutorService {
  private readonly logger = new Logger(OrchestratorToolExecutorService.name);

  constructor() {}

  private validateUrl(urlStr: string): URL {
    const url = new URL(urlStr);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Protocol not allowed: ${url.protocol}`);
    }

    const hostname = url.hostname.toLowerCase();

    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new Error(`Host not allowed: ${hostname}`);
    }

    if (this.isPrivateIp(hostname)) {
      throw new Error(`Private IP not allowed: ${hostname}`);
    }

    return url;
  }

  private isPrivateIp(hostname: string): boolean {
    const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const p = m.slice(1).map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 0) return true;
    return false;
  }

  async executeExternalApi({
    functionName,
    args,
    toolsList,
    client_phone,
    company_phone,
    _accumulatedResult = {},
  }: {
    functionName: string;
    args: Record<string, unknown>;
    toolsList: any[];
    client_phone?: string;
    company_phone?: string;
    _accumulatedResult?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const toolConfig = toolsList.find((t: any) => t.name === functionName);

    if (!toolConfig) {
      this.logger.error({ functionName }, `Tool ${functionName} não encontrada`);
      return { error: `Tool ${functionName} não encontrada` };
    }

    const contextData = { ...args };
    let finalPayload: any = contextData;

    if (toolConfig.request_body_template) {
      finalPayload = this.constructRequestBody(toolConfig.request_body_template, contextData, toolConfig);
    }

    this.logger.log({ functionName, finalPayload: sanitize(finalPayload) }, `[TOOL] Executando tool`);

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.EXTERNAL_TOOL_TIMEOUT || '30000', 10);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const validatedUrl = this.validateUrl(toolConfig.endpoint);

      const isGetOrHead = ['GET', 'HEAD'].includes((toolConfig.method || 'POST').toUpperCase());

      const fetchOptions: any = {
        method: toolConfig.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(toolConfig.headers || {}),
        },
        signal: controller.signal,
      };

      if (!isGetOrHead) {
        fetchOptions.body = JSON.stringify(finalPayload);
      }

      const response = await fetch(validatedUrl.href, fetchOptions);

      clearTimeout(timeoutId);

      const responseText = await response.text();

      let rawData: Record<string, unknown>;
      try {
        rawData = JSON.parse(responseText);
      } catch {
        rawData = { result: responseText };
      }

      if (!response.ok) {
        this.logger.error({ functionName, status: response.status, response: responseText }, 'Falha na tool');
        return { error: `Erro na tool ${functionName} (Status ${response.status}): ${responseText}` };
      }

      let currentStepData: Record<string, unknown> = rawData;
      if (toolConfig.extract_data) {
        currentStepData = extractDataFromResponse(rawData, toolConfig.extract_data);
        if (currentStepData) {
          this.logger.log({ functionName, extractedKeys: Object.keys(currentStepData) }, `Dados extraídos`);
        }
      }

      const newAccumulatedResult = { ..._accumulatedResult, ...currentStepData };

      if (toolConfig.next_tool) {
        this.logger.log({ from: functionName, to: toolConfig.next_tool }, 'Encadeamento de ferramentas');
        return this.executeExternalApi({
          functionName: toolConfig.next_tool,
          args: newAccumulatedResult,
          toolsList,
          client_phone,
          company_phone,
          _accumulatedResult: newAccumulatedResult,
        });
      }

      return newAccumulatedResult;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        this.logger.error({ functionName, timeout: '10s' }, 'Timeout excedido');
        return { error: `Timeout na tool ${functionName}` };
      }
      this.logger.error({ functionName, error: error.message }, 'Erro na tool');
      return { error: error.message };
    }
  }

  private constructRequestBody(template: any, args: Record<string, unknown>, schema: any): any {
    if (!template) return args;

    let bodyStr = JSON.stringify(template);
    const systemVars = this.getSystemVariables();
    const combinedArgs = { ...systemVars, ...args };

    bodyStr = bodyStr.replace(/{{(.*?)}}/g, (_, key: string) => {
      const trimmedKey = key.trim();
      const value = combinedArgs[trimmedKey];
      return value === undefined || value === null ? '' : String(value);
    });

    bodyStr = bodyStr.replace(/{{.*?}}/g, '');
    const parsedBody = JSON.parse(bodyStr);

    if (schema?.parameters?.properties) {
      const props = schema.parameters.properties;
      this.applySchemaTypes(props, parsedBody);
      if (parsedBody.params) {
        this.applySchemaTypes(props, parsedBody.params);
      }
    }

    return parsedBody;
  }

  private getSystemVariables() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return {
      today_date: now.toISOString().split('T')[0],
      tomorrow_date: tomorrow.toISOString().split('T')[0],
    };
  }

  private applySchemaTypes(schemaProperties: any, parsedBody: any) {
    if (!schemaProperties || !parsedBody) return;

    for (const key in schemaProperties) {
      const schema = schemaProperties[key];
      let value = parsedBody[key];
      if (value === undefined || value === null) continue;

      const expectedType = schema.type?.toLowerCase();

      switch (expectedType) {
        case 'number':
        case 'integer': {
          const num = Number(value);
          if (!isNaN(num)) parsedBody[key] = num;
          break;
        }
        case 'boolean': {
          if (typeof value === 'string') parsedBody[key] = value.toLowerCase() === 'true' || value === '1';
          else parsedBody[key] = Boolean(value);
          break;
        }
        case 'string': {
          parsedBody[key] = String(value);
          break;
        }
        case 'stringdecimal': {
          let numVal = value;
          if (typeof value === 'string') numVal = value.replace(',', '.');
          const num = parseFloat(numVal);
          parsedBody[key] = !isNaN(num) ? String(num) : String(value);
          break;
        }
        case 'object': {
          this.applySchemaTypes(schema.properties, parsedBody[key]);
          break;
        }
        case 'array': {
          if (Array.isArray(value) && schema.items) {
            parsedBody[key] = value.map((item: any) => {
              if (schema.items.type === 'number') {
                const n = Number(item);
                return isNaN(n) ? 0 : n;
              }
              return item;
            });
          }
          break;
        }
      }
    }
  }
}
