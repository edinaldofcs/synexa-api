export interface OpenAiStreamChunk {
  deltaContent: string;
  toolCallFragments: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsFragment?: string;
  }>;
  finishReason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}

export async function* readOpenAiSseChunks(
  response: Response,
): AsyncGenerator<OpenAiStreamChunk> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = parsed?.choices?.[0];
        const delta = choice?.delta || {};
        yield {
          deltaContent: typeof delta.content === 'string' ? delta.content : '',
          toolCallFragments: Array.isArray(delta.tool_calls)
            ? delta.tool_calls.map((tc: any) => ({
                index: Number(tc.index || 0),
                id: tc.id,
                name: tc.function?.name,
                argumentsFragment: tc.function?.arguments,
              }))
            : [],
          finishReason: choice?.finish_reason || null,
          usage: parsed?.usage
            ? {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
              }
            : null,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
