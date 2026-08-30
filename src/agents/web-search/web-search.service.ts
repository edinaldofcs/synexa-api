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

    // 1. Tentar OpenRouter se a chave estiver configurada
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (
      openRouterKey &&
      !openRouterKey.startsWith('mock') &&
      openRouterKey !== 'invalid'
    ) {
      try {
        const client = this.getClient();
        const completion = await client.chat.completions.create({
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

        if (answer) {
          return {
            answer,
            results: [
              {
                title: 'Resposta da busca web',
                snippet: answer,
                link: firstCitation,
              },
            ],
            source: `OpenRouter (${WEB_SEARCH_MODEL})`,
            model: WEB_SEARCH_MODEL,
            citations,
          };
        }
      } catch (error) {
        this.logger.warn(
          { error: error instanceof Error ? error.message : 'desconhecido' },
          'Falha na busca OpenRouter. Acionando motor de busca público...',
        );
      }
    }

    // 2. Fallback resiliente: DuckDuckGo + Wikipedia Search Engine
    try {
      const publicResults = await this.queryPublicSearch(normalizedQuestion);
      if (publicResults.answer || publicResults.results.length > 0) {
        return publicResults;
      }
    } catch (publicError) {
      this.logger.warn(
        { error: (publicError as Error).message },
        'Falha no motor de busca público',
      );
    }

    // Todos os provedores falharam: sinaliza erro explicitamente para o LLM
    // em vez de retornar um placeholder fabricado como se fosse dado real
    return {
      answer: '',
      results: [],
      source: 'Synexa Live Web Search',
      error: `Busca web indisponível no momento para "${normalizedQuestion}". Informe ao usuário que não foi possível consultar a internet agora.`,
    };
  }

  private async queryPublicSearch(query: string): Promise<WebSearchResponse> {
    const results: WebSearchResult[] = [];
    const citations: string[] = [];
    let summary = '';

    // 1. DuckDuckGo HTML Live Search (Resultados, Notícias e Esportes em Tempo Real)
    try {
      const liveRes = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (liveRes.ok) {
        const html = await liveRes.text();
        const resultBlocks = html.split('<div class="result results_links');

        for (let i = 1; i < Math.min(resultBlocks.length, 6); i++) {
          const block = resultBlocks[i];
          const snippetMatch =
            /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
              block,
            );
          const linkMatch =
            /<a[^>]+class="[^"]*result__url[^"]*"[^>]+href="([^"]*)"/i.exec(
              block,
            );
          const headingMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);

          const title = headingMatch
            ? headingMatch[1].replace(/<[^>]+>/g, '').trim()
            : 'Resultado Web';
          const snippet = snippetMatch
            ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
            : '';
          let link = linkMatch ? linkMatch[1] : '';
          if (link.includes('uddg=')) {
            link = decodeURIComponent(link.split('uddg=')[1].split('&')[0]);
          }

          if (snippet) {
            results.push({ title, snippet, link });
            if (link) citations.push(link);
          }
        }
      }
    } catch {
      // continua para os próximos fallbacks se timeout
    }

    // 2. DuckDuckGo Instant Answer API
    if (results.length === 0) {
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const ddgRes = await fetch(ddgUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (ddgRes.ok) {
          const ddgJson = (await ddgRes.json()) as any;
          const abstract =
            ddgJson.AbstractText ||
            ddgJson.Answer ||
            (ddgJson.RelatedTopics && ddgJson.RelatedTopics[0]?.Text);
          const url =
            ddgJson.AbstractURL ||
            (ddgJson.RelatedTopics && ddgJson.RelatedTopics[0]?.FirstURL);

          if (abstract) {
            results.push({
              title: ddgJson.Heading || query,
              snippet: abstract,
              link:
                url || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
            });
            if (url) citations.push(url);
          }
        }
      } catch {
        // ignore
      }
    }

    // 3. Wikipedia OpenSearch API
    if (results.length < 3) {
      try {
        const wikiUrl = `https://pt.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json`;
        const wikiRes = await fetch(wikiUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (wikiRes.ok) {
          const [searchTerm, titles, snippets, urls] =
            (await wikiRes.json()) as [string, string[], string[], string[]];
          for (let i = 0; i < (titles || []).length; i++) {
            const title = titles[i];
            const snippet =
              snippets[i] || `Artigo enciclopédico sobre ${title}`;
            const link = urls[i] || '';
            if (title && link) {
              results.push({ title, snippet, link });
              citations.push(link);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (results.length > 0) {
      summary = results
        .slice(0, 3)
        .map((r) => `${r.title}: ${r.snippet}`)
        .join('\n\n');
    }

    // Sem texto fabricado: answer vazio sinaliza ao caller (ask) que nenhum
    // dado real foi obtido, acionando o retorno com flag de erro
    return {
      answer: summary,
      results,
      source: 'Synexa Live Web Search Engine',
      citations: Array.from(new Set(citations)),
    };
  }

  async execute(args: Record<string, unknown>): Promise<WebSearchResponse> {
    const query = this.extractQuery(args);
    if (!query) {
      return {
        answer: '',
        results: [],
        source: 'Synexa Web Search',
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
