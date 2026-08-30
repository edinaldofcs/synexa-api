import OpenAI from 'openai';
import { Logger } from '@nestjs/common';
import { parseStructuredResponse } from '../utils/llm-parser.util';
import { logBenchmark } from '../utils/benchmark-logger.util';
import { llmConfig } from './llm-config';
import { runOpenAiCompatibleChatStream } from '../utils/openai-chat-stream.util';
import type {
  LLMProvider,
  ChatParams,
  AgentChatParams,
} from './llm-provider.interface';
import type { AgentOutput } from '../types/agent-message.types';

function formatHistoryForOpenAI(
  history: { role: string; content: string }[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return history.map((msg) => {
    let content = msg.content;
    if (msg.role === 'assistant') {
      try {
        JSON.parse(content);
      } catch {
        content = JSON.stringify({ text: content });
      }
    }
    return {
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content,
    } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function simplifySchema(parameters: any): any {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const schema = JSON.parse(JSON.stringify(parameters));

  if (schema.properties) {
    for (const key in schema.properties) {
      if (schema.properties[key].type === 'integer')
        schema.properties[key].type = 'number';
      if (schema.properties[key].description === '')
        delete schema.properties[key].description;
    }
  }
  return schema;
}

function buildOpenAIToolDefinition(toolsArray: any[]) {
  return toolsArray.map((tool: any) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: simplifySchema(tool.parameters),
    },
  }));
}

const SYSTEM_SUFFIX =
  '\n\nIMPORTANTE: Ao chamar ferramentas, respeite rigorosamente os tipos do schema. Campos do tipo string (como CEP, códigos, CPF, telefone e identificadores) DEVEM SEMPRE ser passados entre aspas como strings (ex: "81450718").';

export class OpenRouterProvider implements LLMProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);
  private openai: OpenAI;
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey || '',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/antigravity',
        'X-Title': 'Synexa Orchestrator',
      },
    });
    this.apiKey = apiKey || '';
  }

  async chat({
    systemPrompt,
    userMessage,
    history,
    publicTools,
    allToolsList,
    executeExternalApiCallback,
  }: ChatParams) {
    const startTime = new Date();
    const calledTools: string[] = [];
    let hadToolCalls = false;
    const model = llmConfig.models.openrouter;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const totalCost = 0;

    try {
      const toolsDefinition =
        publicTools && publicTools.length > 0
          ? buildOpenAIToolDefinition(publicTools)
          : undefined;

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt + SYSTEM_SUFFIX },
        ...formatHistoryForOpenAI(history),
        { role: 'user', content: userMessage },
      ];

      let responseMessage: OpenAI.Chat.ChatCompletionMessage;
      let loopCount = 0;
      const MAX_LOOPS = 10;

      while (loopCount < MAX_LOOPS) {
        loopCount++;

        const payload: OpenAI.Chat.ChatCompletionCreateParams = {
          model,
          messages,
          temperature: 0.1,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'agent_response',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description:
                      'A resposta de texto do assistente para o usuário.',
                  },
                },
                required: ['text'],
                additionalProperties: false,
              },
            },
          },
        };

        if (toolsDefinition) {
          payload.tools = toolsDefinition;
          (payload as any).tool_choice = 'auto';
        }

        this.logger.log(
          `Enviando mensagem para OpenRouter (Loop ${loopCount})`,
        );
        const chatCompletion =
          await this.openai.chat.completions.create(payload);

        if (chatCompletion.usage) {
          totalInputTokens += chatCompletion.usage.prompt_tokens || 0;
          totalOutputTokens += chatCompletion.usage.completion_tokens || 0;
        }

        responseMessage = chatCompletion.choices[0].message;
        messages.push(
          responseMessage as OpenAI.Chat.ChatCompletionMessageParam,
        );

        if (
          responseMessage.tool_calls &&
          responseMessage.tool_calls.length > 0
        ) {
          hadToolCalls = true;
          for (const toolCall of responseMessage.tool_calls) {
            const tc = toolCall as OpenAI.Chat.ChatCompletionMessageToolCall & {
              function: { name: string; arguments: string };
            };
            const functionName = tc.function.name;
            calledTools.push(functionName);
            // Args truncados/malformados do LLM não devem derrubar o request
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              this.logger.warn(
                `Argumentos inválidos do LLM para ${functionName}; seguindo com objeto vazio`,
              );
              args = {};
            }

            this.logger.log(`OpenRouter chamou: ${functionName}`);

            const apiResult = await executeExternalApiCallback({
              functionName,
              args,
              toolsList: allToolsList,
            });

            messages.push({
              tool_call_id: tc.id,
              role: 'tool',
              content: JSON.stringify(apiResult),
            } as OpenAI.Chat.ChatCompletionMessageParam);

            if (apiResult?.error || apiResult?.ok === false) {
              this.logger.warn(
                `⛔ [Fail-Fast] Tool ${functionName} falhou no OpenRouterProvider. Interrompendo chamadas subsequentes.`,
              );
              const pendingCalls = responseMessage.tool_calls.slice(
                responseMessage.tool_calls.indexOf(toolCall) + 1,
              );
              for (const pending of pendingCalls) {
                messages.push({
                  tool_call_id: (pending as any).id,
                  role: 'tool',
                  content: JSON.stringify({
                    error:
                      'Execução cancelada: a tool anterior falhou (Fail-Fast).',
                  }),
                } as OpenAI.Chat.ChatCompletionMessageParam);
              }
              break;
            }
          }
        } else {
          break;
        }
      }

      this.logger.log('Resposta final da OpenRouter obtida.');

      const endTime = new Date();
      logBenchmark({
        userMessage,
        aiResponse: responseMessage!.content,
        provider: 'openrouter',
        model,
        startTime,
        endTime,
        hadToolCalls,
        calledTools,
        latencyMs: endTime.getTime() - startTime.getTime(),
        status: 'success',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: totalCost,
      });

      const parsed = parseStructuredResponse(responseMessage!.content);
      return {
        ...parsed,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
        },
      };
    } catch (error) {
      const endTime = new Date();
      logBenchmark({
        userMessage,
        aiResponse: null,
        provider: 'openrouter',
        model,
        startTime,
        endTime,
        hadToolCalls,
        calledTools,
        latencyMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: totalCost,
      });

      throw error;
    }
  }

  async chatWithPartsStream(
    params: AgentChatParams,
    onToken: (chunk: string) => void,
  ): Promise<AgentOutput> {
    return runOpenAiCompatibleChatStream({
      logger: this.logger,
      providerName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: this.apiKey,
      model: params.agentConfig.model || llmConfig.models.openrouter,
      params: { ...params, systemPrompt: params.systemPrompt + SYSTEM_SUFFIX },
      toolsDefinition:
        params.tools.length > 0
          ? buildOpenAIToolDefinition(params.tools)
          : [],
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/antigravity',
        'X-Title': 'Synexa Orchestrator',
      },
      onToken,
    });
  }
}
