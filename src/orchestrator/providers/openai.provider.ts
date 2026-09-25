import { DEFAULT_CAPABILITIES } from '../types/capabilities.types';
import OpenAI from 'openai';
import type {
  ResponseInput,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import type {
  AgentChatParams,
  ChatParams,
  LLMProvider,
} from './llm-provider.interface';
import type { AgentOutput } from '../types/agent-message.types';
import { llmConfig } from './llm-config';

/** Direct OpenAI integration. Responses preserves reasoning between tool turns. */
export class OpenAiProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY || '',
      baseURL: 'https://api.openai.com/v1',
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  async chat(params: ChatParams) {
    const output = await this.chatWithParts({
      systemPrompt: params.systemPrompt,
      input: { text: params.userMessage },
      history: params.history.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        parts: [{ type: 'text', text: message.content, order_index: 0 }],
      })),
      capabilities: DEFAULT_CAPABILITIES,
      tools: params.publicTools || [],
      agentConfig: {},
      onToolCall: (functionName, args) =>
        params.executeExternalApiCallback({
          functionName,
          args,
          toolsList: params.allToolsList,
        }),
    });
    return { ...output, action: 'speak' };
  }

  chatWithParts(params: AgentChatParams): Promise<AgentOutput> {
    return this.run(params);
  }

  chatWithPartsStream(
    params: AgentChatParams,
    onToken: (chunk: string) => void,
  ) {
    return this.run(params, onToken);
  }

  private async run(
    params: AgentChatParams,
    onToken?: (chunk: string) => void,
  ): Promise<AgentOutput> {
    const model = params.agentConfig.model || llmConfig.models.openai;
    const input: ResponseInput = params.history.map((message) => ({
      role:
        message.role === 'assistant'
          ? ('assistant' as const)
          : ('user' as const),
      content: message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text || '')
        .join('\n'),
    }));
    input.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            [
              params.input.text,
              ...(params.input.parts || [])
                .filter((p) => p.type === 'text')
                .map((p) => p.text),
            ]
              .filter(Boolean)
              .join('\n') || 'Continue.',
        },
        ...(params.input.parts || [])
          .filter((p) => p.type === 'image' && p.media_url)
          .map((p) => ({
            type: 'input_image' as const,
            image_url: p.media_url!,
            detail: 'auto' as const,
          })),
      ],
    });
    const allowedTools = new Set(params.tools.map((tool) => tool.name));
    let tools: ResponseCreateParamsNonStreaming['tools'] = params.tools.map(
      (tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }),
    );
    let inputTokens = 0;
    let outputTokens = 0;
    for (let turn = 0; turn < 10; turn++) {
      const payload: ResponseCreateParamsNonStreaming = {
        model,
        instructions: params.systemPrompt,
        input,
        tools,
        store: false,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: 16384,
        // Reasoning models reject temperature; let their defaults apply.
        ...(/^gpt-4(?:\.|o)/.test(model)
          ? { temperature: params.agentConfig.temperature ?? 0.3 }
          : {}),
      };
      let response: OpenAI.Responses.Response | undefined;
      if (onToken) {
        const stream = await this.client.responses.create({
          ...payload,
          stream: true,
        });
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') onToken(event.delta);
          if (event.type === 'response.completed') response = event.response;
          if (
            event.type === 'response.failed' ||
            event.type === 'response.incomplete' ||
            event.type === 'error'
          ) {
            throw new Error(
              'OpenAI não concluiu a resposta. Verifique o modelo e os limites da conta.',
            );
          }
        }
      } else {
        response = await this.client.responses.create(payload);
      }
      if (!response || response.status !== 'completed')
        throw new Error('Resposta OpenAI incompleta.');
      inputTokens += response.usage?.input_tokens || 0;
      outputTokens += response.usage?.output_tokens || 0;
      const calls = response.output.filter(
        (item) => item.type === 'function_call',
      );
      if (!calls.length) {
        const text = response.output
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content)
          .map((item) =>
            item.type === 'output_text'
              ? item.text
              : item.type === 'refusal'
                ? item.refusal
                : '',
          )
          .join('');
        return {
          text,
          parts: [{ type: 'text', text, order_index: 0 }],
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
      }
      input.push(
        ...response.output.filter(
          (item) =>
            item.type === 'message' ||
            item.type === 'reasoning' ||
            item.type === 'function_call',
        ),
      );
      let failed = false;
      for (const call of calls) {
        let result: unknown;
        try {
          if (failed)
            throw new Error(
              'Execução cancelada: a ferramenta anterior falhou.',
            );
          if (!allowedTools.has(call.name))
            throw new Error('Ferramenta não autorizada.');
          const args: unknown = JSON.parse(call.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Argumentos de ferramenta inválidos.');
          result = await params.onToolCall(
            call.name,
            args as Record<string, unknown>,
          );
        } catch (error) {
          result = {
            error:
              error instanceof Error ? error.message : 'Falha na ferramenta.',
          };
        }
        const record = result as Record<string, unknown> | undefined;
        if (record?.error || record?.ok === false) failed = true;
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(result ?? {}),
        });
      }
      if (failed) {
        tools = [];
        allowedTools.clear();
      }
    }
    throw new Error('OpenAI excedeu o limite de chamadas de ferramentas.');
  }
}
