import { Logger } from '@nestjs/common';
import { readOpenAiSseChunks } from './sse-stream.util';
import type { AgentOutput } from '../types/agent-message.types';
import type { AgentChatParams } from '../providers/llm-provider.interface';

const MAX_STREAM_TOOL_LOOPS = 10;

export interface OpenAiCompatibleStreamOptions {
  logger: Logger;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  params: AgentChatParams;
  toolsDefinition: any[];
  extraHeaders?: Record<string, string>;
  onToken: (chunk: string) => void;
}

function buildStreamMessages(params: AgentChatParams): any[] {
  const messages: any[] = [{ role: 'system', content: params.systemPrompt }];

  for (const msg of params.history) {
    const text = (msg.parts || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('\n');
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    });
  }

  const inputText =
    [
      params.input.text || '',
      ...(params.input.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text || ''),
    ]
      .filter(Boolean)
      .join('\n') || 'Continue.';
  messages.push({ role: 'user', content: inputText });

  return messages;
}

export async function runOpenAiCompatibleChatStream(
  options: OpenAiCompatibleStreamOptions,
): Promise<AgentOutput> {
  const { logger, providerName, baseUrl, apiKey, params } = options;
  const messages = buildStreamMessages(params);
  const calledTools: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let finalText = '';

  for (let loop = 0; loop < MAX_STREAM_TOOL_LOOPS; loop++) {
    const payload: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      temperature: params.agentConfig.temperature ?? 0.3,
    };
    if (options.toolsDefinition.length > 0) {
      payload.tools = options.toolsDefinition;
      payload.tool_choice = 'auto';
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(options.extraHeaders || {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        `${providerName} stream error ${res.status}: ${await res.text()}`,
      );
    }

    let content = '';
    const toolCallsAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of readOpenAiSseChunks(res)) {
      if (chunk.usage) {
        totalInput += chunk.usage.prompt_tokens;
        totalOutput += chunk.usage.completion_tokens;
      }
      if (chunk.deltaContent) {
        content += chunk.deltaContent;
        options.onToken(chunk.deltaContent);
      }
      for (const fragment of chunk.toolCallFragments) {
        const acc =
          toolCallsAcc.get(fragment.index) || { id: '', name: '', arguments: '' };
        if (fragment.id) acc.id = fragment.id;
        if (fragment.name) acc.name += fragment.name;
        if (fragment.argumentsFragment) acc.arguments += fragment.argumentsFragment;
        toolCallsAcc.set(fragment.index, acc);
      }
    }

    const toolCallsBatch = [...toolCallsAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .filter((value) => value.id && value.name);

    if (toolCallsBatch.length === 0) {
      finalText = content;
      break;
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCallsBatch.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments || '{}',
        },
      })),
    });

    let failure = false;
    for (const toolCall of toolCallsBatch) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.arguments || '{}');
      } catch {
        logger.warn(
          `Argumentos inválidos do LLM para ${toolCall.name}; seguindo com objeto vazio`,
        );
      }
      calledTools.push(toolCall.name);
      let toolResult: unknown;
      try {
        toolResult = await params.onToolCall(
          toolCall.name,
          args as Record<string, unknown>,
        );
      } catch (error) {
        toolResult = {
          error:
            error instanceof Error ? error.message : 'Erro ao executar tool',
        };
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult ?? {}),
      });
      const resultRecord = toolResult as Record<string, unknown> | undefined;
      if (resultRecord?.error || resultRecord?.ok === false) {
        logger.warn(
          `⛔ [Fail-Fast] Tool ${toolCall.name} falhou no ${providerName} (stream). Interrompendo chamadas subsequentes.`,
        );
        failure = true;
        break;
      }
    }

    if (failure) break;
  }

  return {
    text: finalText,
    parts: [{ type: 'text', text: finalText, order_index: 0 }],
    citations: [],
    usage: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      total_tokens: totalInput + totalOutput,
    },
  };
}
