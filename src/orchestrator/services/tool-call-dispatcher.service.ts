import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NativeToolsService } from '../../common/services/native-tools.service';
import type { AgentConfig } from '../types/capabilities.types';
import { sanitize } from '../../common/utils/sanitize-log.util';

@Injectable()
export class ToolCallDispatcher {
  private readonly logger = new Logger(ToolCallDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nativeToolsService: NativeToolsService,
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
      case 'validate_variable_part':
      case 'validate_variable':
      case 'set_session_variable':
      case 'set_call_variable':
      case 'set_variable':
      case 'calculate_financial':
      case 'calculate_discount_installment':
        return this.nativeToolsService.execute(toolName, args, state);
      default:
        return { result: 'tool_executed', toolName };
    }
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
}
