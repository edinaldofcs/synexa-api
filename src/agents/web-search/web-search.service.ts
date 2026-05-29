import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export interface WebSearchResult {
  title: string;
  snippet: string;
  link: string;
}

export interface WebSearchResponse {
  answer: string;
  results: WebSearchResult[];
  source: string;
  model?: string;
  citations?: string[];
  error?: string;
}

export interface WebSearchToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const WEB_SEARCH_TOOL_ID = 'web_search';
const WEB_SEARCH_MODEL = 'openai/gpt-oss-20b:free:online';
const WEB_SEARCH_SYSTEM_PROMPT = `
Voce e um agente objetivo com pesquisa na internet.

REGRAS:
- Responda de forma curta.
- Maximo 5 linhas.
- Nao explique o processo.
- Nao liste tudo que encontrou.
- Resuma apenas a informacao principal.
- Nunca mostre reasoning.
- Nunca repita a pergunta.
- Use portugues brasileiro.
`.trim();

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);
  private client: OpenAI | null = null;

  getToolDefinition(): WebSearchToolDefinition {
    return {
      name: WEB_SEARCH_TOOL_ID,
      description:
        'Pesquisa na internet e devolve uma resposta curta em portugues brasileiro. Use para fatos atuais, noticias, horarios, precos e informacoes que podem mudar.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Pergunta ou termo para pesquisar na web.',
          },
        },
        required: ['query'],
      },
    };
  }

  getNativeToolId(): string {
    return WEB_SEARCH_TOOL_ID;
  }

  async ask(question: string): Promise<WebSearchResponse> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      throw new BadRequestException('A pergunta e obrigatoria.');
    }

    try {
      const completion = await this.getClient().chat.completions.create({
        model: WEB_SEARCH_MODEL,
        messages: [
          { role: 'system', content: WEB_SEARCH_SYSTEM_PROMPT },
          { role: 'user', content: normalizedQuestion },
        ],
        temperature: 0.3,
        max_tokens: 120,
      } as any);

      const answer = completion.choices?.[0]?.message?.content?.trim() || '';
      const citations = this.extractCitations(completion);
      const firstCitation = citations[0] || '';

      return {
        answer,
        results: answer
          ? [
              {
                title: 'Resposta da busca web',
                snippet: answer,
                link: firstCitation,
              },
            ]
          : [],
        source: `OpenRouter (${WEB_SEARCH_MODEL})`,
        model: WEB_SEARCH_MODEL,
        citations,
      };
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'Erro desconhecido',
        'WebSearchService.ask',
      );

      return {
        answer: '',
        results: [],
        source: 'OpenRouter',
        model: WEB_SEARCH_MODEL,
        citations: [],
        error:
          'Erro ao executar agente de busca via OpenRouter: ' +
          (error instanceof Error ? error.message : 'desconhecido'),
      };
    }
  }

  async execute(args: Record<string, unknown>): Promise<WebSearchResponse> {
    const query = this.extractQuery(args);
    if (!query) {
      return {
        answer: '',
        results: [],
        source: 'OpenRouter',
        model: WEB_SEARCH_MODEL,
        citations: [],
        error: 'query e obrigatoria.',
      };
    }

    return this.ask(query);
  }

  private getClient(): OpenAI {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY nao configurada.');
    }

    if (!this.client) {
      this.client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        defaultHeaders: {
          'HTTP-Referer':
            process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
          'X-Title': process.env.OPENROUTER_APP_TITLE || 'Synexa Web Search',
        },
      });
    }

    return this.client;
  }

  private extractQuery(args: Record<string, unknown>): string {
    const value = args.query || args.question || args.pergunta;
    return typeof value === 'string' ? value.trim() : '';
  }

  private extractCitations(completion: unknown): string[] {
    const urls = new Set<string>();
    const addUrl = (value: unknown) => {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        urls.add(value);
      }
    };

    const raw = completion as any;
    for (const citation of raw?.citations || []) {
      addUrl(citation?.url || citation);
    }

    const annotations = raw?.choices?.[0]?.message?.annotations || [];
    for (const annotation of annotations) {
      addUrl(annotation?.url);
      addUrl(annotation?.url_citation?.url);
      addUrl(annotation?.citation?.url);
    }

    const messageCitations = raw?.choices?.[0]?.message?.citations || [];
    for (const citation of messageCitations) {
      addUrl(citation?.url || citation);
    }

    return Array.from(urls);
  }
}
