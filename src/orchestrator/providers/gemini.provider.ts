import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { Logger } from '@nestjs/common';
import { parseStructuredResponse } from '../utils/llm-parser.util';
import { logBenchmark } from '../utils/benchmark-logger.util';
import { llmConfig } from './llm-config';
import type {
  AgentOutput,
  AgentMessage,
  MessagePart,
} from '../types/agent-message.types';
import type {
  LLMProvider,
  ChatParams,
  AgentChatParams,
  ProviderCapabilities,
} from './llm-provider.interface';

function formatHistoryForGemini(history: { role: string; content: string }[]) {
  const formatted: { role: string; parts: { text: string }[] }[] = [];
  let firstUserFound = false;

  for (const msg of history) {
    if (msg.role === 'user') firstUserFound = true;

    if (firstUserFound) {
      let content = msg.content;

      if (msg.role === 'assistant') {
        try {
          JSON.parse(content);
        } catch {
          content = JSON.stringify({ text: content, action: 'speak' });
        }
      }

      formatted.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      });
    }
  }

  return formatted;
}

function buildToolDefinition(toolsArray: any[]) {
  return {
    functionDeclarations: toolsArray.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}

function agentPartToGeminiPart(part: MessagePart): any {
  switch (part.type) {
    case 'text':
      return { text: part.text || '' };
    case 'image':
      if (part.media_url)
        return { inlineData: { mimeType: 'image/*', data: part.media_url } };
      return { text: `[Image: ${part.media_asset_id || 'unknown'}]` };
    case 'audio':
      return { text: `[Audio: ${part.media_asset_id || 'unknown'}]` };
    case 'tool_result':
      return {
        text: `[Tool ${part.tool_name || 'unknown'} result]: ${JSON.stringify(part.tool_result)}`,
      };
    case 'rag_context':
      return { text: `[RAG context]: ${part.text || ''}` };
    case 'citation':
      return {
        text: `[Citation from ${part.citation?.document || 'unknown'}]: ${part.citation?.text || ''}`,
      };
    default:
      return { text: part.text || '' };
  }
}

function agentHistoryToGemini(
  history: AgentMessage[],
): { role: string; parts: any[] }[] {
  return history.map((msg) => ({
    role:
      msg.role === 'assistant'
        ? 'model'
        : msg.role === 'system'
          ? 'user'
          : msg.role,
    parts: msg.parts.map(agentPartToGeminiPart),
  }));
}

const SYSTEM_SUFFIX =
  '\n\nIMPORTANTE: Ao chamar ferramentas, certifique-se de passar valores numéricos (integer/number) SEM ASPAS. Não use strings para campos que esperam números.';

export class GeminiProvider implements LLMProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }

  getCapabilities(): ProviderCapabilities {
    return {
      text: true,
      vision: true,
      audio: false,
      tools: true,
    };
  }

  async chat({
    systemPrompt,
    userMessage,
    history,
    publicTools,
    allToolsList,
    executeExternalApiCallback,
  }: ChatParams) {
    const startTime = new Date();
    const calledTools: string[] = [];
    let hadToolCalls = false;
    const modelName = llmConfig.models.gemini;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    try {
      const toolsDefinition =
        publicTools && publicTools.length > 0
          ? buildToolDefinition(publicTools)
          : undefined;

      const structuredSystemPrompt = systemPrompt + SYSTEM_SUFFIX;

      const modelConfig: any = {
        model: modelName,
        systemInstruction: structuredSystemPrompt,
      };

      if (toolsDefinition) {
        modelConfig.tools = [toolsDefinition];
      }

      const model = this.genAI.getGenerativeModel(modelConfig);
      const geminiHistory = formatHistoryForGemini(history);

      const chatSession = model.startChat({
        history: geminiHistory,
        generationConfig: {
          temperature: 0.3,
        } as any,
      });

      this.logger.log('Enviando mensagem para Gemini');
      let result = await chatSession.sendMessage(userMessage);
      let response = await result.response;

      if (response.usageMetadata) {
        const input = response.usageMetadata.promptTokenCount || 0;
        const output = response.usageMetadata.candidatesTokenCount || 0;
        totalInputTokens += input;
        totalOutputTokens += output;
        totalCost += input * 0.000000075 + output * 0.0000003;
      }

      let functionCalls = response.functionCalls();

      while (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        const { name: functionName, args } = call;

        this.logger.log(`Gemini chamou: ${functionName}`);
        hadToolCalls = true;
        calledTools.push(functionName);

        const apiResult = await executeExternalApiCallback({
          functionName,
          args: args as Record<string, unknown>,
          toolsList: allToolsList,
        });

        result = await chatSession.sendMessage([
          { functionResponse: { name: functionName, response: apiResult } },
        ]);

        response = await result.response;
        if (response.usageMetadata) {
          const input = response.usageMetadata.promptTokenCount || 0;
          const output = response.usageMetadata.candidatesTokenCount || 0;
          totalInputTokens += input;
          totalOutputTokens += output;
          totalCost += input * 0.000000075 + output * 0.0000003;
        }
        functionCalls = response.functionCalls();
      }

      const finalText = response.text();
      this.logger.log('Resposta final da Gemini obtida.');

      const endTime = new Date();
      logBenchmark({
        userMessage,
        aiResponse: finalText,
        provider: 'gemini',
        model: modelName,
        startTime,
        endTime,
        hadToolCalls,
        calledTools,
        latencyMs: endTime.getTime() - startTime.getTime(),
        status: 'success',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: totalCost,
      });

      return parseStructuredResponse(finalText);
    } catch (error) {
      const endTime = new Date();
      logBenchmark({
        userMessage,
        aiResponse: null,
        provider: 'gemini',
        model: modelName,
        startTime,
        endTime,
        hadToolCalls,
        calledTools,
        latencyMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: totalCost,
      });

      throw error;
    }
  }

  async chatWithParts(params: AgentChatParams): Promise<AgentOutput> {
    const startTime = Date.now();
    const calledTools: string[] = [];
    const modelName = params.agentConfig.model || llmConfig.models.gemini;
    const inputText = params.input.text || '';
    const inputParts = params.input.parts || [];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      const systemPrompt = params.systemPrompt;
      const toolsDefinition =
        params.tools.length > 0 ? buildToolDefinition(params.tools) : undefined;

      const modelConfig: any = {
        model: modelName,
        systemInstruction: systemPrompt,
      };
      if (toolsDefinition) modelConfig.tools = [toolsDefinition];

      const model = this.genAI.getGenerativeModel(modelConfig);

      const geminiHistory = agentHistoryToGemini(params.history);

      const contents: any[] = [];

      if (inputText || inputParts.length === 0) {
        contents.push({ text: inputText || 'Continue.' });
      }

      for (const part of inputParts) {
        contents.push(agentPartToGeminiPart(part as MessagePart));
      }

      const chatSession = model.startChat({
        history: geminiHistory,
        generationConfig: {
          temperature: params.agentConfig.temperature ?? 0.3,
        } as any,
      });

      let result = await chatSession.sendMessage(contents);
      let response = await result.response;

      if (response.usageMetadata) {
        totalInputTokens += response.usageMetadata.promptTokenCount || 0;
        totalOutputTokens += response.usageMetadata.candidatesTokenCount || 0;
      }

      let functionCalls = response.functionCalls();

      while (functionCalls && functionCalls.length > 0) {
        for (const call of functionCalls) {
          const { name: toolName, args } = call;
          this.logger.log({ toolName, args }, 'Gemini tool call');
          calledTools.push(toolName);

          const toolResult = await params.onToolCall(
            toolName,
            args as Record<string, unknown>,
          );

          result = await chatSession.sendMessage([
            {
              functionResponse: { name: toolName, response: toolResult as any },
            },
          ]);

          response = await result.response;
          if (response.usageMetadata) {
            totalInputTokens += response.usageMetadata.promptTokenCount || 0;
            totalOutputTokens +=
              response.usageMetadata.candidatesTokenCount || 0;
          }
          functionCalls = response.functionCalls();
        }
      }

      const finalText = response.text();

      this.logger.log(
        { model: modelName, latency: Date.now() - startTime },
        'chatWithParts complete',
      );

      const outputParts: MessagePart[] = [
        { type: 'text', text: finalText, order_index: 0 },
      ];

      return {
        text: finalText,
        parts: outputParts,
        citations: [],
      };
    } catch (error) {
      this.logger.error({ model: modelName, error }, 'chatWithParts failed');
      throw error;
    }
  }
}
