import { OpenRouterProvider } from './openrouter.provider';
import type { AgentChatParams } from './llm-provider.interface';

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chunkJson(delta: any, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }],
  })}\n\n`;
}

const baseParams = (): AgentChatParams => ({
  systemPrompt: 'system prompt',
  input: { text: 'olá', parts: [] },
  history: [],
  capabilities: {} as any,
  tools: [],
  agentConfig: { model: 'google/gemini-2.5-flash', temperature: 0.3 },
  onToolCall: jest.fn(),
});

describe('OpenRouterProvider.chatWithPartsStream', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emite tokens via onToken e retorna o texto completo', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          chunkJson({ content: 'Olá, ' }),
          chunkJson({ content: 'mundo!' }),
          chunkJson({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
      );
    (global as any).fetch = fetchMock;

    const tokens: string[] = [];
    const provider = new OpenRouterProvider('test-key');
    const output = await provider.chatWithPartsStream!(baseParams(), (token) =>
      tokens.push(token),
    );

    expect(tokens.join('')).toBe('Olá, mundo!');
    expect(output.text).toBe('Olá, mundo!');
    expect(output.parts?.[0]).toMatchObject({
      type: 'text',
      text: 'Olá, mundo!',
    });
  });

  it('executa tool calls não-streamed e continua o turno até o texto final', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          chunkJson({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'rag.search', arguments: '{"query":"x"}' },
              },
            ],
          }),
          chunkJson({}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([chunkJson({ content: 'resposta final' })]),
      );
    (global as any).fetch = fetchMock;

    const tokens: string[] = [];
    const params = baseParams();
    params.onToolCall = jest.fn().mockResolvedValue({ ok: true, data: [] });
    const provider = new OpenRouterProvider('test-key');
    const output = await provider.chatWithPartsStream!(params, (token) =>
      tokens.push(token),
    );

    expect(params.onToolCall).toHaveBeenCalledWith('rag.search', {
      query: 'x',
    });
    expect(output.text).toBe('resposta final');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('acumula usage dos chunks de stream', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      sseResponse([
        chunkJson({ content: 'abc' }),
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })}\n\n`,
      ]),
    );
    (global as any).fetch = fetchMock;

    const provider = new OpenRouterProvider('test-key');
    const output = await provider.chatWithPartsStream!(baseParams(), () => {});

    expect(output.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });
});
