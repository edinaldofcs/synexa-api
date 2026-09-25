import { LlmToolLoopService, LlmToolLoopParams } from './llm-tool-loop.service';
import { ApiToolExecutorService } from './api-tool-executor.service';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import { OpenAiProvider } from '../providers/openai.provider';
import type { AgentChatParams } from '../providers/llm-provider.interface';

describe('LlmToolLoopService OpenAI', () => {
  const executor = { buildOpenAiTools: jest.fn(), executeToolCall: jest.fn() };
  const keys = { resolveApiKey: jest.fn() };
  const service = new LlmToolLoopService(
    executor as unknown as ApiToolExecutorService,
    keys as unknown as ProviderKeyResolverService,
  );
  const params = (): LlmToolLoopParams => ({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    message: 'Consulte',
    history: [],
    tools: [{ id: '1', name: 'Consulta', functionName: 'consulta' }],
    context: { clientId: 'cliente', companyId: 'empresa' },
  });
  beforeEach(() => {
    jest.clearAllMocks();
    executor.buildOpenAiTools.mockReturnValue([
      {
        type: 'function',
        function: { name: 'consulta', parameters: { type: 'object' } },
      },
    ]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lista apenas famílias de LLM e usa a chave OpenAI', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4.1-mini' },
            { id: 'gpt-5-mini' },
            { id: 'gpt-6-astra' },
            { id: 'gpt-4o-realtime-preview' },
            { id: 'text-embedding-3-small' },
            { id: 'whisper-1' },
            {},
          ],
        }),
      ),
    );
    expect(await service.listModels('openai', 'test-key')).toEqual([
      'gpt-4.1-mini',
      'gpt-5-mini',
      'gpt-6-astra',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
  });
  it('expõe erro de autenticação ao carregar modelos', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }));
    await expect(service.listModels('openai', 'invalid')).rejects.toThrow(
      '401',
    );
  });
  it('preserva escopo do cliente e não envia campos brutos à OpenAI', async () => {
    executor.executeToolCall.mockResolvedValue({
      name: 'consulta',
      result: {
        ok: true,
        data: { nome: 'Cliente' },
        raw: { secret: 'private' },
      },
    });
    jest
      .spyOn(OpenAiProvider.prototype, 'chatWithParts')
      .mockImplementation(async (p: AgentChatParams) => {
        expect(await p.onToolCall('consulta', {})).toEqual({
          ok: true,
          nome: 'Cliente',
        });
        return { text: 'Pronto', usage: { total_tokens: 12 } };
      });
    const output = await service.run(params());
    expect(output.text).toBe('Pronto');
    expect(output.toolCalls).toHaveLength(1);
    expect(executor.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          nativeRagContext: expect.objectContaining({
            clientId: 'cliente',
            companyId: 'empresa',
          }),
        }),
      }),
    );
  });
  it('encaminha streaming e imagens ao mesmo provider', async () => {
    const token = jest.fn();
    const stream = jest
      .spyOn(OpenAiProvider.prototype, 'chatWithPartsStream')
      .mockResolvedValue({ text: 'Imagem' });
    await service.run({
      ...params(),
      onToken: token,
      files: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          parts: [
            { type: 'image', media_url: 'data:image/png;base64,aGVsbG8=' },
          ],
        }),
      }),
      token,
    );
  });
  it('não envia a chave OpenAI à transcrição Groq', async () => {
    keys.resolveApiKey.mockResolvedValue('');
    await expect(
      service.run({
        ...params(),
        files: [{ mimeType: 'audio/wav', data: 'audio' }],
      }),
    ).rejects.toThrow('Configure Groq');
    expect(keys.resolveApiKey).toHaveBeenCalledWith('cliente', 'groq');
  });
});
