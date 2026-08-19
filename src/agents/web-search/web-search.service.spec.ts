import { BadRequestException } from '@nestjs/common';
import OpenAI from 'openai';
import { WebSearchService } from './web-search.service';

jest.mock('openai');

describe('WebSearchService', () => {
  const createMock = jest.fn();

  let service: WebSearchService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-key';
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: {
        completions: {
          create: createMock,
        },
      },
    }));
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'Agora sao 10:00 em Brasilia.',
            citations: ['https://example.com/time'],
          },
        },
      ],
    });
    service = new WebSearchService();
  });

  it('answers with the fixed OpenRouter web-search model', async () => {
    const result = await service.ask(' horario de brasilia agora ');

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai/gpt-oss-20b:free:online',
        max_tokens: 120,
      }),
    );
    expect(result.answer).toBe('Agora sao 10:00 em Brasilia.');
    expect(result.results[0]).toEqual({
      title: 'Resposta da busca web',
      snippet: 'Agora sao 10:00 em Brasilia.',
      link: 'https://example.com/time',
    });
  });

  it('accepts pergunta or query as tool arguments', async () => {
    await service.execute({ pergunta: 'cotacao dolar hoje' });
    await service.execute({ query: 'noticias atuais' });

    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'user', content: 'cotacao dolar hoje' },
        ]),
      }),
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'user', content: 'noticias atuais' },
        ]),
      }),
    );
  });

  it('rejects direct empty questions', async () => {
    await expect(service.ask('   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
