import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { ConversationsService } from '../../conversations/conversations.service';
import { WebSearchService } from '../../agents/web-search/web-search.service';
import type { AgentConfig } from '../types/capabilities.types';
import { sanitize } from '../../common/utils/sanitize-log.util';

@Injectable()
export class ToolCallDispatcher {
  private readonly logger = new Logger(ToolCallDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly conversationsService: ConversationsService,
    private readonly webSearchService: WebSearchService,
  ) {}

  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    agentConfig: AgentConfig,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    state: Record<string, unknown>,
    requestId?: string,
    onSearchRag?: (query: string, limit: number) => Promise<any>,
  ): Promise<any> {
    this.logger.log(
      { toolName: sanitize(String(toolName)), args: sanitize(args) },
      'Native tool call dispatched',
    );

    switch (toolName) {
      case 'rag.search':
        if (onSearchRag) {
          return onSearchRag(String(args.query || ''), Number(args.limit || 5));
        }
        return { error: 'RAG search handler not registered' };
      case 'web_search':
        return this.searchWeb(
          agentConfig,
          String(args.query || args.question || args.pergunta || ''),
          agentRunId,
          conversationId,
          messageId,
          companyId,
          requestId,
        );
      case 'media.transcribe':
        return this.transcribeMedia(
          String(args.media_asset_id || ''),
          agentRunId,
          conversationId,
          messageId,
          companyId,
          clientId,
          requestId,
        );
      case 'media.describe_image':
        return this.describeImageMedia(
          String(args.media_asset_id || ''),
          agentRunId,
          conversationId,
          messageId,
          companyId,
          clientId,
          requestId,
        );
      case 'switch_agent':
        return this.handleSwitchAgent(
          String(args.target_agent || ''),
          String(args.reason || ''),
          clientId,
          conversationId,
          state,
        );
      case 'set_variable':
        return this.handleSetVariable(
          (args.variables as Record<string, unknown>) || {},
          conversationId,
        );
      case 'transfer_to_human':
      case 'request_handoff':
        return this.handleTransferToHuman(
          conversationId,
          String(args.reason || 'solicitação do usuário'),
        );
      default:
        return { result: 'tool_executed', toolName };
    }
  }

  async searchWeb(
    agentConfig: AgentConfig,
    query: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ): Promise<{ result: string; sources: string[] }> {
    const startedAt = Date.now();

    const toolCall = await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id:
          agentConfig.id === 'default'
            ? '00000000-0000-0000-0000-000000000000'
            : agentConfig.id,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'web_search',
        tool_type: 'native',
        arguments: { query } as any,
        status: 'running',
      },
    });

    try {
      const cacheKey = `websearch:${createHash('md5').update(query.toLowerCase().trim()).digest('hex')}`;
      const cached = await this.redisService.get<{
        results: string[];
        sources: string[];
      }>(cacheKey);

      if (cached) {
        await this.completeWebSearchTool(
          toolCall.id,
          startedAt,
          cached.results,
          cached.sources,
        );
        return { result: cached.results.join('\n\n'), sources: cached.sources };
      }

      const searchResponse = await this.webSearchService.execute({ query });

      const searchResults: string[] = [];
      const sources: string[] = [];

      for (const r of searchResponse.results) {
        searchResults.push(`${r.title}\n${r.snippet}`);
        sources.push(r.link);
        if (searchResults.length >= 5) break;
      }

      if (searchResponse.error && searchResults.length === 0) {
        throw new Error(searchResponse.error);
      }

      const resultText =
        searchResults.length > 0
          ? searchResults.join('\n\n')
          : 'Nenhum resultado encontrado.';

      await this.redisService.set(cacheKey, {
        results: searchResults,
        sources: sources.slice(0, 5),
      });

      await this.completeWebSearchTool(
        toolCall.id,
        startedAt,
        searchResults,
        sources.slice(0, 5),
      );

      return { result: resultText, sources: sources.slice(0, 5) };
    } catch (error) {
      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'failed',
          latency_ms: Date.now() - startedAt,
          error_message:
            error instanceof Error ? error.message : 'Web search failed',
          completed_at: new Date(),
        },
      });

      return {
        result: `Erro na busca web: ${error instanceof Error ? error.message : 'unknown'}`,
        sources: [],
      };
    }
  }

  private async completeWebSearchTool(
    toolCallId: string,
    startedAt: number,
    results: string[],
    sources: string[],
  ) {
    await this.prisma.tool_calls.update({
      where: { id: toolCallId },
      data: {
        status: 'success',
        latency_ms: Date.now() - startedAt,
        result: { count: results.length, sources } as any,
        completed_at: new Date(),
      },
    });
  }

  async transcribeMedia(
    mediaAssetId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    requestId?: string,
  ) {
    if (!mediaAssetId) return { error: 'media_asset_id é obrigatório' };

    await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'media.transcribe',
        tool_type: 'native',
        arguments: { media_asset_id: mediaAssetId } as any,
        status: 'completed',
        latency_ms: 0,
        completed_at: new Date(),
      },
    });

    const asset = await this.prisma.media_assets.findUnique({
      where: { id: mediaAssetId },
    });

    if (!asset) return { error: 'Media asset not found' };
    if (asset.transcript) return { transcript: asset.transcript };

    return {
      error:
        'Transcricao ainda nao disponivel. O audio pode estar sendo processado.',
    };
  }

  async describeImageMedia(
    mediaAssetId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    clientId: string,
    requestId?: string,
  ) {
    if (!mediaAssetId) return { error: 'media_asset_id é obrigatório' };

    await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'media.describe_image',
        tool_type: 'native',
        arguments: { media_asset_id: mediaAssetId } as any,
        status: 'completed',
        latency_ms: 0,
        completed_at: new Date(),
      },
    });

    const asset = await this.prisma.media_assets.findUnique({
      where: { id: mediaAssetId },
    });

    if (!asset) return { error: 'Media asset not found' };
    if (asset.ocr_text) return { description: asset.ocr_text };

    return {
      error:
        'Descricao ainda nao disponivel. A imagem pode estar sendo processada.',
    };
  }

  async handleSwitchAgent(
    targetAgent: string,
    reason: string,
    clientId: string,
    conversationId: string,
    _state: Record<string, unknown>,
  ) {
    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: { id: true, service_step: true },
    });

    const target = agents.find(
      (a) => a.id === targetAgent || a.service_step === targetAgent,
    );

    if (!target) {
      this.logger.warn(
        { targetAgent, clientId },
        'switch_agent: target agent not found',
      );
      return {
        result: 'agent_not_found',
        message: `Agente "${targetAgent}" não encontrado.`,
      };
    }

    const freshState = await this.conversationsService.getState(conversationId);
    await this.conversationsService.updateState(conversationId, {
      ...freshState,
      pending_agent_id: target.id,
      switch_reason: reason || null,
    });

    this.logger.log(
      {
        from: sanitize(String(freshState.current_agent_id || 'unknown')),
        to: sanitize(target.service_step || target.id),
        reason: sanitize(reason || 'sem motivo'),
      },
      'switch_agent: transferência agendada',
    );

    return {
      result: 'agent_switched',
      message: `Conversa transferida para "${target.service_step || target.id}".`,
      target_agent: target.service_step || target.id,
    };
  }

  async handleSetVariable(
    variables: Record<string, unknown>,
    conversationId: string,
  ) {
    if (!variables || Object.keys(variables).length === 0) {
      return { result: 'no_variables', message: 'Nenhuma variável fornecida.' };
    }

    const freshState = await this.conversationsService.getState(conversationId);
    await this.conversationsService.updateState(conversationId, {
      ...freshState,
      ...variables,
    });

    this.logger.log(
      { keys: sanitize(String(Object.keys(variables))) },
      'set_variable: variáveis atualizadas',
    );

    return {
      result: 'variables_set',
      message: `${Object.keys(variables).length} variável(is) definida(s).`,
      variables_set: Object.keys(variables),
    };
  }

  webSearchToolDefinition() {
    const def = this.webSearchService.getToolDefinition();
    return {
      ...def,
      type: 'native' as const,
    };
  }

  mediaTranscribeToolDefinition() {
    return {
      name: 'media.transcribe',
      type: 'native' as const,
      description:
        'Transcreve um audio para texto. Use quando o usuario enviar um audio e precisar do conteudo transcrito.',
      parameters: {
        type: 'object',
        properties: {
          media_asset_id: {
            type: 'string',
            description: 'ID do media asset do audio',
          },
        },
        required: ['media_asset_id'],
      },
    };
  }

  mediaDescribeImageToolDefinition() {
    return {
      name: 'media.describe_image',
      type: 'native' as const,
      description:
        'Descreve o conteudo de uma imagem ou extrai texto visivel (OCR). Use quando o usuario enviar uma imagem.',
      parameters: {
        type: 'object',
        properties: {
          media_asset_id: {
            type: 'string',
            description: 'ID do media asset da imagem',
          },
        },
        required: ['media_asset_id'],
      },
    };
  }

  switchAgentToolDefinition() {
    return {
      name: 'switch_agent',
      description:
        'Transfere a conversa para outro agente. Use quando identificar que o agente atual não é o mais adequado para a solicitação do usuário.',
      parameters: {
        type: 'object',
        properties: {
          target_agent: {
            type: 'string',
            description:
              'Nome (service_step) ou ID do agente de destino para transferir a conversa',
          },
          reason: {
            type: 'string',
            description: 'Motivo da transferência (opcional)',
          },
        },
        required: ['target_agent'],
      },
    };
  }

  setVariableToolDefinition() {
    return {
      name: 'set_variable',
      description:
        'Define uma ou mais variáveis no estado da conversa para controle de fluxo entre agentes.',
      parameters: {
        type: 'object',
        properties: {
          variables: {
            type: 'object',
            description:
              'Objeto com as variáveis a serem definidas. Ex: {"intent": "suporte", "sentiment": "positive"}',
            additionalProperties: true,
          },
        },
        required: ['variables'],
      },
    };
  }

  transferToHumanToolDefinition() {
    return {
      name: 'transfer_to_human',
      description:
        'Transfere o atendimento para um atendente humano / operador. Use SEMPRE que o cliente pedir para falar com um humano, atendente, suporte humano ou quando o problema não puder ser resolvido pela IA.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Motivo da transferência para o atendente humano (ex: "solicitação do cliente", "dúvida complexa").',
          },
        },
        required: [],
      },
    };
  }

  async handleTransferToHuman(
    conversationId: string,
    reason: string,
  ): Promise<{ status: string; message: string }> {
    this.logger.log(
      { conversation_id: conversationId, reason },
      'Tool transfer_to_human executada pela IA',
    );
    try {
      await this.conversationsService.requestHandoff(conversationId, {
        reason,
        requested_by: 'ai_tool',
      });
      return {
        status: 'transferred',
        message:
          'Atendimento transferido para a equipe de atendentes humanos com sucesso. Avise o usuário cordialmente que um operador irá atendê-lo a seguir.',
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Não foi possível transferir: ${err.message}`,
      };
    }
  }
}
