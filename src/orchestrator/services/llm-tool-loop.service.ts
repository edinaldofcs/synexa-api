import { Injectable, Logger } from '@nestjs/common';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import {
  ApiTool,
  ApiToolExecutorService,
  ToolCallDebug,
} from './api-tool-executor.service';
import { truncateToolResult } from '../utils/truncate-tool-result.util';
import { readOpenAiSseChunks } from '../utils/sse-stream.util';

export interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmLoopFiles {
  mimeType: string;
  data: string;
}

export interface LlmToolLoopParams {
  provider: string;
  model: string;
  apiKey: string;
  message: string;
  files?: LlmLoopFiles[];
  systemPrompt?: string;
  history: MemoryMessage[];
  tools: ApiTool[];
  context?: {
    clientId?: string;
    companyId?: string;
    conversationId?: string;
    messageId?: string;
    agentRunId?: string;
    agentConfig?: import('../types/capabilities.types').AgentConfig;
  };
  onToken?: (chunk: string) => void;
}

export interface LlmToolLoopResult {
  text: string;
  toolCalls: ToolCallDebug[];
  transcription?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Loop único de chamada LLM com function calling no formato OpenAI
 * (Gemini/Groq/OpenRouter), incluindo fallback direto ao Gemini sem tools,
 * transcrição de áudio e OCR de imagens. Usado pelo Test Chat e disponível
 * para a engine de produção.
 */
@Injectable()
export class LlmToolLoopService {
  private readonly logger = new Logger(LlmToolLoopService.name);

  constructor(
    private readonly apiToolExecutor: ApiToolExecutorService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
  ) {}

  async run(params: LlmToolLoopParams): Promise<LlmToolLoopResult> {
    const nativeRagContext = params.context
      ? {
          agentConfig: params.context.agentConfig,
          clientId: params.context.clientId || '',
          companyId: params.context.companyId || '',
          conversationId: params.context.conversationId,
          messageId: params.context.messageId,
          agentRunId: params.context.agentRunId,
        }
      : undefined;

    switch (params.provider.toLowerCase()) {
      case 'gemini':
        if (params.tools.length > 0) {
          return this.callOpenAICompatible(
            'https://generativelanguage.googleapis.com/v1beta/openai',
            params,
            nativeRagContext,
          );
        }
        return this.callGemini(params);
      case 'groq':
        return this.callOpenAICompatible(
          'https://api.groq.com/openai/v1',
          params,
          nativeRagContext,
        );
      case 'openrouter':
        return this.callOpenAICompatible(
          'https://openrouter.ai/api/v1',
          params,
          nativeRagContext,
        );
      default:
        throw new Error(`Provedor desconhecido: ${params.provider}`);
    }
  }

  async listModels(provider: string, apiKey: string): Promise<string[]> {
    switch (provider.toLowerCase()) {
      case 'gemini':
        return this.listGeminiModels(apiKey);
      case 'groq':
        return this.listGroqModels(apiKey);
      case 'openrouter':
        return this.listOpenRouterModels(apiKey);
      default:
        throw new Error(`Provedor desconhecido: ${provider}`);
    }
  }

  // ── OpenAI-compatible com loop de function calling ──────────────

  private async callOpenAICompatible(
    baseUrl: string,
    params: LlmToolLoopParams,
    nativeRagContext?: {
      agentConfig?: import('../types/capabilities.types').AgentConfig;
      clientId: string;
      companyId: string;
      conversationId?: string;
      messageId?: string;
      agentRunId?: string;
    },
  ): Promise<LlmToolLoopResult> {
    const {
      provider,
      model,
      apiKey,
      message,
      files,
      systemPrompt,
      history,
      tools: apiTools,
    } = params;
    const openAiTools = this.apiToolExecutor.buildOpenAiTools(apiTools);
    const toolsByFunctionName = new Map(
      apiTools.map((tool) => [tool.functionName, tool]),
    );

    const toolInstruction =
      openAiTools.length > 0
        ? '\n\n[INSTRUÇÃO DE FERRAMENTAS]: Ao chamar ferramentas, certifique-se de que todos os parâmetros do tipo string (como CEP, CPF, telefones, códigos ou identificadores numéricos) sejam SEMPRE passados entre aspas como strings (ex: "81450718"), NUNCA como número sem aspas.'
        : '';

    const messages: any[] = [];
    const finalSystemPrompt = `${systemPrompt || ''}${toolInstruction}`.trim();
    if (finalSystemPrompt) {
      messages.push({ role: 'system', content: finalSystemPrompt });
    }
    for (const item of history) {
      messages.push({ role: item.role, content: item.content });
    }

    const imageFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('image/'),
    );
    const audioFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('audio/'),
    );

    let userText = message;
    let transcription: string | undefined;
    if (audioFiles.length > 0) {
      const transcriptions: string[] = [];
      const transcriptionKey =
        provider.toLowerCase() === 'groq'
          ? apiKey
          : nativeRagContext
            ? await this.providerKeyResolver.resolveApiKey(
                nativeRagContext.clientId,
                'groq',
              )
            : apiKey;
      for (const audioFile of audioFiles) {
        const transcript = await this.transcribeAudioBuffer(
          audioFile.data,
          audioFile.mimeType,
          transcriptionKey,
        );
        transcriptions.push(transcript);
      }
      transcription = transcriptions.join('\n');
      userText = `${userText}\n\n<transcricao_audio>\n${transcription}\n</transcricao_audio>`;
    }

    if (imageFiles.length > 0) {
      const descriptions: string[] = [];
      for (const imageFile of imageFiles) {
        descriptions.push(
          await this.describeImageForChat(
            imageFile,
            provider,
            apiKey,
            nativeRagContext?.clientId,
          ),
        );
      }
      const imageContext = descriptions
        .map(
          (description) =>
            `<transcricao_imagem>\n${description}\n</transcricao_imagem>`,
        )
        .join('\n\n');

      const userInstruction =
        message && message.trim() && message !== 'Descreva o arquivo anexado.'
          ? message
          : 'O usuário enviou uma imagem/documento anexado. Considere as informações transcritas na tag <transcricao_imagem> acima como dados e contexto fornecidos pelo usuário e dê andamento ao fluxo de atendimento normalmente, sem apenas descrever a imagem.';

      userText = `${imageContext}\n\n${userInstruction}`;
    }
    messages.push({ role: 'user', content: userText });
    let responseMessage: any = null;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const toolCalls: ToolCallDebug[] = [];
    let currentTools = openAiTools.length ? [...openAiTools] : [];

    const streaming =
      typeof params.onToken === 'function' &&
      !baseUrl.includes('google') &&
      !baseUrl.includes('generativelanguage');

    for (let loop = 0; loop < 8; loop++) {
      const payload: Record<string, unknown> = {
        model,
        messages,
        max_tokens: 4096,
      };
      if (currentTools.length) {
        payload.tools = currentTools;
        payload.tool_choice = 'auto';
      }
      if (streaming) payload.stream = true;

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (
        baseUrl.includes('google') ||
        baseUrl.includes('generativelanguage')
      ) {
        requestHeaders['x-goog-api-key'] = apiKey;
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok)
        throw new Error(`${baseUrl} error ${res.status}: ${await res.text()}`);
      let json: any;
      if (streaming) {
        let content = '';
        const streamedCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        for await (const chunk of readOpenAiSseChunks(res)) {
          if (chunk.usage) {
            totalInputTokens += chunk.usage.prompt_tokens;
            totalOutputTokens += chunk.usage.completion_tokens;
          }
          if (chunk.deltaContent) {
            content += chunk.deltaContent;
            params.onToken!(chunk.deltaContent);
          }
          for (const fragment of chunk.toolCallFragments) {
            const acc = streamedCalls.get(fragment.index) || {
              id: '',
              name: '',
              arguments: '',
            };
            if (fragment.id) acc.id = fragment.id;
            if (fragment.name) acc.name += fragment.name;
            if (fragment.argumentsFragment)
              acc.arguments += fragment.argumentsFragment;
            streamedCalls.set(fragment.index, acc);
          }
        }
        const callsFromStream = [...streamedCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, value]) => value)
          .filter((value) => value.id && value.name);
        json = {
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                ...(callsFromStream.length
                  ? {
                      tool_calls: callsFromStream.map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: {
                          name: call.name,
                          arguments: call.arguments || '{}',
                        },
                      })),
                    }
                  : {}),
              },
            },
          ],
        };
      } else {
        json = await res.json();
      }
      if (json?.usage) {
        totalInputTokens += json.usage.prompt_tokens || 0;
        totalOutputTokens += json.usage.completion_tokens || 0;
      }
      responseMessage = json?.choices?.[0]?.message;
      if (!responseMessage) break;

      const finishReason = json?.choices?.[0]?.finish_reason;
      const rawContent = responseMessage?.content;
      const contentText =
        typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent
                .map((part: any) =>
                  typeof part?.text === 'string' ? part.text : '',
                )
                .join('')
            : '';
      if (!contentText.trim() && !responseMessage?.tool_calls?.length) {
        this.logger.warn(
          { provider, model, finishReason, loop },
          'chat/completions retornou resposta sem conteúdo textual',
        );
      }
      responseMessage = { ...responseMessage, content: contentText };

      messages.push(responseMessage);
      const calls = responseMessage.tool_calls || [];
      if (!calls.length) break;

      for (const call of calls) {
        const functionName = call?.function?.name;
        const tool = toolsByFunctionName.get(functionName);
        const args = this.apiToolExecutor.parseToolArguments(
          call?.function?.arguments,
        );

        if (!functionName || (!tool && !functionName.startsWith('subagent_'))) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: `Tool ${functionName} nao encontrada`,
            }),
          });
          continue;
        }

        try {
          const debug = await this.apiToolExecutor.executeToolCall({
            tool,
            functionName,
            args,
            context: {
              message,
              nativeRagContext,
              callLlm: (subParams) => this.run(subParams),
            },
          });
          toolCalls.push(debug);
          const result = debug.result as Record<string, any> | undefined;

          const hasFailure = Boolean(result?.error || result?.ok === false);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncateToolResult(result),
          });

          if (hasFailure) {
            this.logger.warn(
              `⛔ [Fail-Fast] Tool ${debug.name} falhou. Interrompendo cadeia de execução.`,
            );
            // Responde chamadas pendentes no mesmo batch como canceladas
            const remainingCalls = calls.slice(calls.indexOf(call) + 1);
            for (const remaining of remainingCalls) {
              messages.push({
                role: 'tool',
                tool_call_id: remaining.id,
                content: JSON.stringify({
                  error:
                    'Execução cancelada: a tool anterior falhou (Fail-Fast).',
                }),
              });
            }
            // Remove tools nas iterações seguintes para forçar resposta de texto imediata
            currentTools = [];
            break;
          }
        } catch (error) {
          const toolName = tool?.name || functionName;
          const result = {
            error:
              error instanceof Error ? error.message : 'Erro ao executar tool',
          };
          toolCalls.push({ name: toolName, arguments: args, result });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncateToolResult(result),
          });

          this.logger.warn(
            `⛔ [Fail-Fast] Tool ${toolName} lançou erro. Interrompendo cadeia de execução.`,
          );
          const remainingCalls = calls.slice(calls.indexOf(call) + 1);
          for (const remaining of remainingCalls) {
            messages.push({
              role: 'tool',
              tool_call_id: remaining.id,
              content: JSON.stringify({
                error:
                  'Execução cancelada: a tool anterior falhou (Fail-Fast).',
              }),
            });
          }
          currentTools = [];
          break;
        }
      }
    }

    let finalText = responseMessage?.content || '';
    if (typeof finalText !== 'string') finalText = String(finalText ?? '');

    // Se o modelo encerrou sem conteúdo textual (ex: após cadeia de tool calls
    // como switch_agent), faz uma chamada final sem ferramentas para forçar texto
    if (!finalText.trim() && messages.length > 0) {
      try {
        const retryPayload: Record<string, unknown> = {
          model,
          messages: [
            ...messages,
            {
              role: 'user',
              content:
                'Use as informações das ferramentas executadas acima e responda ao usuário em texto de forma clara e objetiva.',
            },
          ],
          max_tokens: 4096,
        };
        if (streaming) retryPayload.stream = true;
        const retryHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        };
        if (
          baseUrl.includes('google') ||
          baseUrl.includes('generativelanguage')
        ) {
          retryHeaders['x-goog-api-key'] = apiKey;
        }
        const retryRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: retryHeaders,
          body: JSON.stringify(retryPayload),
          signal: AbortSignal.timeout(15_000),
        });
        if (retryRes.ok) {
          let retryContent: unknown = null;
          if (streaming) {
            let retryText = '';
            for await (const chunk of readOpenAiSseChunks(retryRes)) {
              if (chunk.usage) {
                totalInputTokens += chunk.usage.prompt_tokens;
                totalOutputTokens += chunk.usage.completion_tokens;
              }
              if (chunk.deltaContent) {
                retryText += chunk.deltaContent;
                params.onToken!(chunk.deltaContent);
              }
            }
            retryContent = retryText;
          } else {
            const retryJson = await retryRes.json();
            if (retryJson?.usage) {
              totalInputTokens += retryJson.usage.prompt_tokens || 0;
              totalOutputTokens += retryJson.usage.completion_tokens || 0;
            }
            retryContent = retryJson?.choices?.[0]?.message?.content;
          }
          if (typeof retryContent === 'string' && retryContent.trim()) {
            finalText = retryContent.trim();
          }
        }
      } catch (retryErr) {
        this.logger.warn(
          { error: (retryErr as Error).message },
          'Falha no retry de resposta textual após tool calls',
        );
      }
    }

    return {
      text: finalText || 'Sem resposta',
      toolCalls,
      transcription,
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
      },
    };
  }

  // ── Gemini direto (sem tools) ───────────────────────────────────

  private async callGemini(
    params: LlmToolLoopParams,
  ): Promise<LlmToolLoopResult> {
    const { model, apiKey, files, systemPrompt, history } = params;
    const message = params.message;

    const imageFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('image/'),
    );
    const audioFiles = (files || []).filter((f) =>
      f.mimeType.startsWith('audio/'),
    );

    const userPromptText =
      message && message.trim() && message !== 'Descreva o arquivo anexado.'
        ? message
        : imageFiles.length > 0
          ? 'O usuário enviou a(s) imagem(ns)/documento(s) anexado(s) para dar andamento ao atendimento. Utilize as informações, dados e textos contidos na imagem como contexto fornecido pelo cliente e dê continuidade ao fluxo de atendimento normalmente, sem apenas descrever a imagem.'
          : audioFiles.length > 0
            ? 'O usuário enviou uma mensagem de áudio. Ouça a transcrição e responda ao cliente adequadamente.'
            : '';

    const parts: any[] = [{ text: userPromptText }];

    if (files?.length) {
      for (const file of files) {
        parts.push({
          inlineData: { mimeType: file.mimeType, data: file.data },
        });
      }
    }

    const contents: any[] = [];
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Entendido.' }] });
    }
    for (const item of history) {
      contents.push({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.content }],
      });
    }
    contents.push({ role: 'user', parts });

    let transcription: string | undefined;
    if (audioFiles.length > 0) {
      try {
        const transList: string[] = [];
        for (const af of audioFiles) {
          const transPrompt =
            'Transcreva o áudio a seguir com fidelidade. Retorne estritamente o texto transcrito, sem introduções ou observações.';
          const transRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',
                    parts: [
                      { text: transPrompt },
                      { inlineData: { mimeType: af.mimeType, data: af.data } },
                    ],
                  },
                ],
              }),
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (transRes.ok) {
            const transJson = (await transRes.json()) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
              }>;
            };
            const transText =
              transJson?.candidates?.[0]?.content?.parts
                ?.map((p) => p.text)
                .join('')
                .trim() || '';
            if (transText) transList.push(transText);
          }
        }
        if (transList.length > 0) {
          transcription = transList.join('\n');
        }
      } catch {}
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok)
      throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const promptTokens = json?.usageMetadata?.promptTokenCount || 0;
    const candidatesTokens = json?.usageMetadata?.candidatesTokenCount || 0;

    return {
      text:
        json?.candidates?.[0]?.content?.parts
          ?.map((part: any) => part.text)
          .join('') || 'Sem resposta',
      toolCalls: [],
      transcription,
      usage: {
        input_tokens: promptTokens,
        output_tokens: candidatesTokens,
        total_tokens: promptTokens + candidatesTokens,
      },
    };
  }

  // ── Mídia: transcrição de áudio e OCR de imagem ─────────────────

  private async transcribeAudioBuffer(
    dataBase64: string,
    mimeType: string,
    apiKey: string,
  ): Promise<string> {
    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const ext = mimeType.includes('mp4')
        ? 'mp4'
        : mimeType.includes('wav')
          ? 'wav'
          : mimeType.includes('ogg')
            ? 'ogg'
            : mimeType.includes('mpeg') || mimeType.includes('mp3')
              ? 'mp3'
              : 'webm';

      const blob = new Blob([buffer], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', 'whisper-large-v3');

      const res = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, detail: await res.text() },
          'Falha na transcrição de áudio via Groq',
        );
        return '[Áudio enviado pelo usuário]';
      }
      const json = (await res.json()) as { text?: string };
      return json.text || '[Áudio sem fala detectada]';
    } catch {
      return '[Áudio recebido]';
    }
  }

  private async describeImageForChat(
    file: LlmLoopFiles,
    provider: string,
    apiKey: string,
    clientId?: string,
  ): Promise<string> {
    const prompt =
      'Transcreva todo o texto visível, números, códigos, campos, tabelas e descreva os detalhes e dados relevantes desta imagem em português de forma concisa e factual, para servir estritamente de dados de contexto para um assistente de IA.';

    // 1. Tenta usar Gemini primeiro (ideal e super rápido para OCR/Visão)
    let geminiApiKey: string | undefined;
    if (clientId) {
      try {
        geminiApiKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          'gemini',
        );
      } catch {}
    }
    if (!geminiApiKey) {
      geminiApiKey = process.env.GEMINI_API_KEY;
    }

    if (geminiApiKey) {
      const geminiModel =
        process.env.MEDIA_VISION_MODEL || 'gemini-2.5-flash-lite';
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: file.mimeType,
                        data: file.data,
                      },
                    },
                  ],
                },
              ],
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.ok) {
          const json = await res.json();
          const text =
            json?.candidates?.[0]?.content?.parts
              ?.map((p: any) => p.text)
              .join('')
              .trim() || '';
          if (text) return text;
        } else {
          this.logger.warn(
            { status: res.status, detail: await res.text() },
            'Falha na resposta do Gemini Vision',
          );
        }
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          'Falha na visão via Gemini, tentando fallback',
        );
      }
    }

    // 2. Tenta usar OpenRouter se configurado
    let openRouterKey: string | undefined;
    if (provider.toLowerCase() === 'openrouter') {
      openRouterKey = apiKey;
    } else if (clientId) {
      try {
        openRouterKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          'openrouter',
        );
      } catch {}
    }
    if (!openRouterKey) {
      openRouterKey = process.env.OPENROUTER_API_KEY;
    }

    if (openRouterKey) {
      const model = process.env.MEDIA_VISION_MODEL || 'google/gemini-2.5-flash';
      try {
        const response = await fetch(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openRouterKey}`,
            },
            body: JSON.stringify({
              model,
              max_tokens: 1000,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:${file.mimeType};base64,${file.data}`,
                      },
                    },
                  ],
                },
              ],
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (response.ok) {
          const json = (await response.json()) as {
            choices?: Array<{ message?: { content?: string | unknown[] } }>;
          };
          const content = json.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.trim())
            return content.trim();
          if (Array.isArray(content)) {
            const text = content
              .map((part: any) =>
                typeof part?.text === 'string' ? part.text : '',
              )
              .join('')
              .trim();
            if (text) return text;
          }
        }
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          'Falha na visão via OpenRouter',
        );
      }
    }

    throw new Error(
      'Visão/OCR indisponível: Groq não possui modelos de visão ativos. Por favor, configure uma chave do Google Gemini em Configurações > Provedores para processamento de imagens e documentos.',
    );
  }

  // ── Listagem de modelos por provedor ────────────────────────────

  private async listGeminiModels(apiKey: string): Promise<string[]> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok)
      throw new Error(`Erro ao listar modelos Gemini: ${res.status}`);
    const json = await res.json();
    return (json.models || [])
      .filter((model: any) =>
        model.supportedGenerationMethods?.includes('generateContent'),
      )
      .map((model: any) => model.name.replace('models/', ''))
      .sort();
  }

  private async listGroqModels(apiKey: string): Promise<string[]> {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Erro ao listar modelos Groq: ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .filter((model: any) => model.active)
      .map((model: any) => model.id)
      .sort();
  }

  private async listOpenRouterModels(apiKey: string): Promise<string[]> {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw new Error(`Erro ao listar modelos OpenRouter: ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .filter((model: any) => model.id)
      .map((model: any) => model.id)
      .sort();
  }
}
