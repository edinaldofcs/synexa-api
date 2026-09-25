import OpenAI from 'openai';
import { OpenAiProvider } from './openai.provider';
import { getLLMProvider } from './llm-provider.factory';
import { DEFAULT_CAPABILITIES } from '../types/capabilities.types';
import type { AgentChatParams } from './llm-provider.interface';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
const create = jest.fn();
const params = (): AgentChatParams => ({
  systemPrompt: 'Atenda em português.',
  input: { text: 'Olá' },
  history: [],
  capabilities: DEFAULT_CAPABILITIES,
  agentConfig: { model: 'gpt-5-mini', temperature: 0.2 },
  tools: [
    {
      name: 'consulta',
      description: 'Consulta',
      parameters: {
        type: 'object',
        properties: { numero: { type: 'integer' } },
      },
    },
  ],
  onToolCall: jest.fn().mockResolvedValue({ ok: true }),
});
const response = (output: unknown[]) => ({
  status: 'completed',
  output,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const message = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Olá!' }],
};
const call = (name = 'consulta', args = '{"numero":1}') => ({
  type: 'function_call',
  call_id: name,
  name,
  arguments: args,
});

describe('OpenAiProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    create.mockReset();
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      responses: { create },
    }));
  });
  it('seleciona o provider próprio e o endpoint OpenAI', () => {
    expect(getLLMProvider('openai', 'test-key')).toBeInstanceOf(OpenAiProvider);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
      }),
    );
  });
  it('preserva raciocínio e tipos das ferramentas, acumulando consumo', async () => {
    const reasoning = {
      type: 'reasoning',
      encrypted_content: 'encrypted',
      summary: [],
    };
    create
      .mockResolvedValueOnce(response([reasoning, call()]))
      .mockResolvedValueOnce(response([message]));
    const p = params();
    const result = await new OpenAiProvider('test-key').chatWithParts(p);
    expect(p.onToolCall).toHaveBeenCalledWith('consulta', { numero: 1 });
    expect(result.usage?.total_tokens).toBe(30);
    expect(create.mock.calls[1][0].input).toContainEqual(reasoning);
    expect(create.mock.calls[0][0]).toMatchObject({
      store: false,
      model: 'gpt-5-mini',
      tools: [{ parameters: p.tools[0].parameters }],
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
  it.each([
    ['desconhecida', '{}'],
    ['consulta', 'broken'],
    ['consulta', '[]'],
  ])('não executa chamada inválida %s %s', async (name, args) => {
    create
      .mockResolvedValueOnce(response([call(name, args)]))
      .mockResolvedValueOnce(response([message]));
    const p = params();
    await new OpenAiProvider('test-key').chatWithParts(p);
    expect(p.onToolCall).not.toHaveBeenCalled();
    expect(create.mock.calls[1][0].tools).toEqual([]);
  });
  it('cancela chamadas seguintes após falha e entrega resposta final', async () => {
    create
      .mockResolvedValueOnce(response([call(), call()]))
      .mockResolvedValueOnce(response([message]));
    const p = params();
    (p.onToolCall as jest.Mock).mockResolvedValue({ ok: false });
    const result = await new OpenAiProvider('test-key').chatWithParts(p);
    expect(p.onToolCall).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Olá!');
  });
  it('transmite deltas e contabiliza consumo no evento final', async () => {
    create.mockImplementation(async function* () {
      yield { type: 'response.output_text.delta', delta: 'Olá!' };
      yield { type: 'response.completed', response: response([message]) };
    });
    const token = jest.fn();
    const result = await new OpenAiProvider('test-key').chatWithPartsStream(
      params(),
      token,
    );
    expect(token).toHaveBeenCalledWith('Olá!');
    expect(result.usage?.total_tokens).toBe(15);
  });
  it('rejeita stream encerrado sem evento de conclusão', async () => {
    create.mockImplementation(async function* () {
      yield { type: 'response.output_text.delta', delta: 'Parcial' };
    });
    await expect(
      new OpenAiProvider('test-key').chatWithPartsStream(params(), jest.fn()),
    ).rejects.toThrow('incompleta');
  });
  it('interrompe loops excessivos', async () => {
    create.mockResolvedValue(response([call()]));
    await expect(
      new OpenAiProvider('test-key').chatWithParts(params()),
    ).rejects.toThrow('limite');
    expect(create).toHaveBeenCalledTimes(10);
  });
});
