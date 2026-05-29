import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConversationsService } from '../conversations/conversations.service';
import { getLLMProvider } from './providers/llm-provider.factory';
import { llmConfig } from './providers/llm-config';
import type {
  AgentChatParams,
  ProviderCapabilities,
} from './providers/llm-provider.interface';
import type {
  AgentMessage,
  AgentOutput,
  MessagePart,
} from './types/agent-message.types';
import type {
  AgentConfig,
} from './types/capabilities.types';
import { sanitize } from '../common/utils/sanitize-log.util';
import { AgentConfigResolver } from './services/agent-config-resolver.service';
import { RagSearchService } from './services/rag-search.service';
import { ToolCallDispatcher } from './services/tool-call-dispatcher.service';

export interface ProcessMessageResult {
  responseText: string;
  responseMessageId?: string;
  responseParts?: AgentMessage['parts'];
  agentId?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
  citations?: AgentOutput['citations'];
  hadTools: boolean;
  calledTools: string[];
}

@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsService: ConversationsService,
    private readonly agentConfigResolver: AgentConfigResolver,
    private readonly ragSearchService: RagSearchService,
    private readonly toolCallDispatcher: ToolCallDispatcher,
  ) {}

  async processMessage(
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    text: string,
    requestId?: string,
  ): Promise<ProcessMessageResult> {
    const state = await this.conversationsService.getState(conversationId);

    const agentConfig = await this.agentConfigResolver.resolveAgentConfig(clientId, state);

    await this.conversationsService.updateState(conversationId, {
      ...state,
      current_agent_id: agentConfig.agentId,
    });

    const provider = getLLMProvider();
    const providerCapabilities = provider.getCapabilities?.() || {
      text: true,
      vision: false,
      audio: false,
      tools: false,
    };

    const agentRun = await this.prisma.agent_runs.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        inbound_message_id: messageId,
        request_id: requestId || null,
        agent_id: agentConfig.id === 'default' ? null : agentConfig.id,
        provider: process.env.LLM_PROVIDER || 'gemini',
        model: agentConfig.model || llmConfig.models.gemini,
        status: 'running',
      },
    });

    const inboundMessage = await this.prisma.messages.findUnique({
      where: { id: messageId },
      include: {
        message_parts: { orderBy: { order_index: 'asc' } },
        media_assets: true,
      },
    });

    const inputParts = await this.buildInputParts(
      inboundMessage,
      agentConfig,
      providerCapabilities,
    );

    const history = await this.buildHistory(
      conversationId,
      agentConfig,
      providerCapabilities,
    );

    const ragContext = await this.ragSearchService.buildRagContext(
      agentConfig,
      text,
      clientId,
      agentRun.id,
      conversationId,
      messageId,
      companyId,
      requestId,
    );

    const systemPrompt = ragContext
      ? `${agentConfig.system_prompt}\n\nContexto RAG disponivel:\n${ragContext}\n\nUse o contexto apenas quando ele for relevante.`
      : agentConfig.system_prompt;

    const tools = this.buildToolDefinitions(agentConfig);

    const params: AgentChatParams = {
      systemPrompt,
      input: { text, parts: inputParts },
      history,
      capabilities: agentConfig.capabilities,
      tools,
      agentConfig: {
        model: agentConfig.model || llmConfig.models.gemini,
        temperature: agentConfig.temperature,
        citation_policy: agentConfig.citation_policy.policy,
      },
      ragContext,
      onToolCall: async (toolName, args) => {
        return this.toolCallDispatcher.dispatch(
          String(toolName),
          (args as Record<string, unknown>) || {},
          agentConfig,
          agentRun.id,
          conversationId,
          messageId,
          companyId,
          clientId,
          state,
          requestId,
          async (query, limit) => {
            return this.ragSearchService.searchRag(
              agentConfig,
              query,
              clientId,
              limit,
              agentRun.id,
              conversationId,
              messageId,
              companyId,
              requestId,
            );
          },
        );
      },
    };

    try {
      if (provider.chatWithParts) {
        this.logger.log(
          {
            conversationId: sanitize(conversationId),
            companyId: sanitize(companyId),
          },
          'Processing with chatWithParts',
        );
        const output = await provider.chatWithParts(params);
        const result = await this.handleOutput(
          conversationId,
          companyId,
          requestId,
          output,
          [],
        );
        await this.completeAgentRun(
          agentRun.id,
          'success',
          result.responseMessageId,
        );
        return { ...result, agentId: agentConfig.agentId };
      }

      const legacyOutput = await provider.chat({
        systemPrompt: agentConfig.system_prompt,
        userMessage: text,
        history: [{ role: 'user', content: text }],
        publicTools: [],
        allToolsList: [],
        executeExternalApiCallback: async () => ({}),
      });

      const responseMessage = await this.conversationsService.addMessage({
        conversation_id: conversationId,
        company_id: companyId,
        sender_type: 'ai',
        channel: 'internal',
        direction: 'outbound',
        message_type: 'text',
        content: legacyOutput.text,
        request_id: requestId,
      });

      await this.completeAgentRun(agentRun.id, 'success', responseMessage.id);

      return {
        responseText: legacyOutput.text,
        responseMessageId: responseMessage.id,
        agentId: agentConfig.agentId,
        hadTools: false,
        calledTools: [],
      };
    } catch (error) {
      await this.failAgentRun(agentRun.id, error);
      throw error;
    }
  }

  private async buildInputParts(
    message: any,
    agentConfig: AgentConfig,
    providerCapabilities: ProviderCapabilities,
  ): Promise<Omit<MessagePart, 'order_index'>[]> {
    const parts: Omit<MessagePart, 'order_index'>[] = [];

    if (!message?.message_parts) return parts;

    for (const part of message.message_parts) {
      if (part.part_type === 'text') {
        parts.push({ type: 'text', text: part.text_content || '' });
      }

      if (part.part_type === 'image') {
        if (providerCapabilities.vision && agentConfig.capabilities.vision) {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          if (asset?.storage_path) {
            parts.push({
              type: 'image',
              media_asset_id: asset.id,
              media_url: `${asset.storage_bucket}/${asset.storage_path}`,
            });
          }
        } else {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          const description =
            asset?.ocr_text || '[Imagem sem descricao disponivel]';
          parts.push({ type: 'text', text: `[Imagem: ${description}]` });
        }
      }

      if (part.part_type === 'audio') {
        if (providerCapabilities.audio && agentConfig.capabilities.audio_in) {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          if (asset?.storage_path) {
            parts.push({
              type: 'audio',
              media_asset_id: asset.id,
              media_url: `${asset.storage_bucket}/${asset.storage_path}`,
            });
          }
        } else {
          const asset = message.media_assets?.find(
            (a: any) => a.id === part.media_asset_id,
          );
          const transcript =
            asset?.transcript || '[Audio sem transcricao disponivel]';
          parts.push({
            type: 'text',
            text: `[Audio transcrito: ${transcript}]`,
          });
        }
      }

      if (part.part_type === 'file') {
        parts.push({
          type: 'file',
          text: `[Arquivo: ${part.text_content || part.media_asset_id || 'anexo'}]`,
        });
      }
    }

    return parts;
  }

  private async buildHistory(
    conversationId: string,
    agentConfig: AgentConfig,
    providerCapabilities: ProviderCapabilities,
  ): Promise<AgentMessage[]> {
    const conversation =
      await this.conversationsService.getConversation(conversationId);
    const messages = (conversation as any).messages || [];

    const history: AgentMessage[] = [];

    for (const msg of messages.slice(-20)) {
      if (msg.id === conversationId) continue;

      const parts: MessagePart[] = [];

      if (msg.content) {
        parts.push({ type: 'text', text: msg.content, order_index: 0 });
      }

      if (msg.message_parts) {
        for (const part of msg.message_parts) {
          if (part.part_type === 'text' && part.text_content) {
            parts.push({
              type: 'text',
              text: part.text_content,
              order_index: part.order_index,
            });
          }
          if (part.part_type === 'image') {
            const asset = msg.media_assets?.find(
              (a: any) => a.id === part.media_asset_id,
            );
            if (
              providerCapabilities.vision &&
              agentConfig.capabilities.vision &&
              asset?.storage_path
            ) {
              parts.push({
                type: 'image',
                media_asset_id: asset.id,
                media_url: `${asset.storage_bucket}/${asset.storage_path}`,
                order_index: part.order_index,
              });
            } else {
              parts.push({
                type: 'text',
                text: `[Imagem: ${asset?.ocr_text || 'sem descricao'}]`,
                order_index: part.order_index,
              });
            }
          }
          if (part.part_type === 'audio') {
            const asset = msg.media_assets?.find(
              (a: any) => a.id === part.media_asset_id,
            );
            if (
              providerCapabilities.audio &&
              agentConfig.capabilities.audio_in &&
              asset?.storage_path
            ) {
              parts.push({
                type: 'audio',
                media_asset_id: asset.id,
                media_url: `${asset.storage_bucket}/${asset.storage_path}`,
                order_index: part.order_index,
              });
            } else {
              parts.push({
                type: 'text',
                text: `[Audio: ${asset?.transcript || 'sem transcricao'}]`,
                order_index: part.order_index,
              });
            }
          }
        }
      }

      history.push({
        role: msg.sender_type === 'ai' ? 'assistant' : 'user',
        parts:
          parts.length > 0
            ? parts
            : [{ type: 'text', text: '', order_index: 0 }],
      });
    }

    return history;
  }

  private buildToolDefinitions(agentConfig: AgentConfig) {
    const tools: any[] = [];

    if (
      agentConfig.capabilities.rag ||
      agentConfig.allowed_knowledge_base_ids.length > 0
    ) {
      tools.push(this.ragSearchService.ragToolDefinition());
    }

    if (agentConfig.capabilities.web_search && agentConfig.web_search_allowed) {
      tools.push(this.toolCallDispatcher.webSearchToolDefinition());
    }

    if (agentConfig.capabilities.tools) {
      tools.push(this.toolCallDispatcher.mediaTranscribeToolDefinition());
      tools.push(this.toolCallDispatcher.mediaDescribeImageToolDefinition());
      tools.push(this.toolCallDispatcher.switchAgentToolDefinition());
      tools.push(this.toolCallDispatcher.setVariableToolDefinition());
    }

    return tools;
  }

  private async handleOutput(
    conversationId: string,
    companyId: string,
    requestId: string | undefined,
    output: AgentOutput,
    calledTools: string[],
  ): Promise<ProcessMessageResult> {
    const message = await this.conversationsService.addMessage({
      conversation_id: conversationId,
      company_id: companyId,
      sender_type: 'ai',
      channel: 'internal',
      direction: 'outbound',
      message_type: output.parts ? 'mixed' : 'text',
      content: output.text,
      request_id: requestId,
    });

    return {
      responseText: output.text,
      responseMessageId: message.id,
      responseParts: output.parts,
      hadTools: calledTools.length > 0,
      calledTools,
      citations: output.citations,
    };
  }

  private async completeAgentRun(
    agentRunId: string,
    status: string,
    responseMessageId?: string,
  ) {
    const current = await this.prisma.agent_runs.findUnique({
      where: { id: agentRunId },
    });
    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        status,
        response_message_id: responseMessageId || null,
        completed_at: new Date(),
        latency_ms: current?.started_at
          ? Date.now() - current.started_at.getTime()
          : null,
      },
    });
  }

  private async failAgentRun(agentRunId: string, error: unknown) {
    await this.completeAgentRun(agentRunId, 'failed');
    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        error_message:
          error instanceof Error ? error.message : 'Agent run failed',
      },
    });
  }
}
