import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import type { ClearTestChatDto, TestChatDto } from './dto/test-chat.dto';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  type ActivationConditionGroup,
} from './utils/condition-evaluator.util';
import type { AgentConfig } from './types/capabilities.types';
import { resolvePromptTemplateString } from '../common/utils/prompt-variables.util';
import { resolveConditionalString } from '../common/utils/conditional-prompt.util';
import {
  InboundDataMapperService,
  InboundMappingConfig,
} from '../common/services/inbound-data-mapper.service';
import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { ModelPricingService } from './services/model-pricing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { MediaService } from '../media/media.service';
import { CrmDataTransformerService } from '../common/services/crm-data-transformer.service';
import {
  ApiToolExecutorService,
  type ApiTool,
  type NativeRagRuntimeContext,
  type ToolCallDebug,
} from './services/api-tool-executor.service';
import {
  LlmToolLoopService,
  type MemoryMessage,
} from './services/llm-tool-loop.service';

const TEST_CHAT_CONTEXT_KEY = 'test_chat_context_variables';
const PAINEL_MESSAGES_LIMIT = 50;
const LOCK_RETRY_ATTEMPTS = 2;
const LOCK_RETRY_DELAY_MS = 300;

/**
 * S02: contexto do usuario autenticado extraido do token (@CurrentUser).
 * Quando presente, o acesso a clients de outros tenants e bloqueado.
 */
export interface TestChatUserContext {
  id: string;
  company_id: string | null;
  role: string;
}

export interface TestChatDebug {
  conversationId?: string;
  externalUserId?: string;
  originChannel: string;
  provider?: string;
  model?: string;
  agentId?: string;
  effectiveSystemPrompt?: string;
  rawSystemPrompt?: string;
  latencyMs?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  memory: {
    source: 'redis' | 'database' | 'none';
    messagesUsed: number;
  };
  contextVariables: Record<string, unknown>;
  availableTools: string[];
  toolCalls: ToolCallDebug[];
  crmRecord?: Record<string, unknown>;
}

/**
 * Fachada do Test Chat (painel): gerencia sessão de teste, contexto,
 * memória Redis, agent runs e telemetria, delegando o catálogo/execução de
 * ferramentas para ApiToolExecutorService e o loop de LLM para
 * LlmToolLoopService — o mesmo núcleo disponível para a engine de produção.
 */
@Injectable()
export class TestChatService {
  private readonly logger = new Logger(TestChatService.name);
  private readonly memoryLimit = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
    private readonly modelPricingService: ModelPricingService,
    private readonly conversationsService: ConversationsService,
    private readonly mediaService: MediaService,
    private readonly crmDataTransformer: CrmDataTransformerService,
    private readonly analyticsService: AnalyticsService,
    private readonly apiToolExecutor: ApiToolExecutorService,
    private readonly llmToolLoop: LlmToolLoopService,
  ) {}

  async listModels(
    provider: string,
    apiKey?: string,
    clientId?: string,
  ): Promise<string[]> {
    let finalKey = this.isMaskedOrPlaceholder(apiKey)
      ? ''
      : apiKey?.trim() || '';

    if (!finalKey) {
      finalKey = await this.providerKeyResolver.resolveApiKey(
        clientId || '',
        provider,
      );
    }

    return this.llmToolLoop.listModels(provider, finalKey);
  }

  async clear(dto: ClearTestChatDto, user?: TestChatUserContext) {
    // S02: sem user autenticado (uso interno/testes) o comportamento atual
    // e mantido; com user, o client precisa pertencer a mesma company.
    if (user) {
      const client = await this.prisma.painel_clients.findUnique({
        where: { id: dto.clientId },
        select: { company_id: true },
      });
      if (!client || client.company_id !== user.company_id) {
        throw new ForbiddenException('Client not found or access denied');
      }
    }

    const originChannel = dto.originChannel || 'webchat_test';
    const conversations = await this.prisma.conversations.findMany({
      where: {
        client_id: dto.clientId,
        origin_channel: originChannel,
        external_conversation_key: `${originChannel}:${dto.externalUserId}`,
      },
      select: { id: true },
    });

    for (const conversation of conversations) {
      await this.redisService.del(this.memoryKey(conversation.id));
      await this.redisService.del(`lock:test-chat:${conversation.id}`);
    }

    if (conversations.length) {
      await this.prisma.conversations.deleteMany({
        where: {
          id: { in: conversations.map((conversation) => conversation.id) },
        },
      });
    }

    return { cleared: true, conversations: conversations.length };
  }

  async send(
    dto: TestChatDto,
    onToken?: (chunk: string) => void,
    user?: TestChatUserContext,
  ): Promise<{
    text: string;
    agentName?: string;
    transcription?: string;
    debug?: TestChatDebug;
  }> {
    const message = dto.message || '';
    let { provider, model, apiKey, files, systemPrompt, clientId, agentId } =
      dto;
    const originChannel = dto.originChannel || 'webchat_test';
    const externalUserId = dto.externalUserId;
    let companyId: string | undefined;
    let conversationId: string | undefined;
    let contextVariables: Record<string, unknown> = {};
    let availableTools: string[] = [];
    let apiTools: ApiTool[] = [];
    let allClientApiNames: string[] = [];
    let resolvedAgentId: string | undefined = agentId;
    let resolvedAgentName: string | undefined;
    let resolvedAgentConfig: AgentConfig | undefined;
    // Leituras deduplicadas por turno (P31): client/conversation/state são
    // carregados uma única vez e repassados ao longo do fluxo.
    let client: Awaited<ReturnType<TestChatService['loadPainelClient']>> = null;
    let conversationRecord: Awaited<
      ReturnType<TestChatService['loadConversationRecord']>
    > = null;
    let state: Record<string, unknown> = {};

    if (clientId) {
      client = await this.loadPainelClient(clientId);
      // S02: com usuario autenticado, client inexistente ou de outra company
      // recebem a MESMA mensagem (sem enumerar existencia de clients).
      if (user && (!client || client.company_id !== user.company_id)) {
        throw new ForbiddenException('Client not found or access denied');
      }
      if (!client) throw new Error('Cliente nao encontrado');
      companyId = client.company_id;

      const metadata = (client.metadata as any) || {};
      const inboundConfig =
        metadata.inbound_variable_mapping as InboundMappingConfig;
      const mapper = new InboundDataMapperService();
      const mappedInbound = mapper.mapInboundData(
        metadata,
        inboundConfig,
        originChannel || 'webchat',
      );

      contextVariables = {
        ...this.sanitizeContextVariables(metadata),
        ...mappedInbound,
      };
      contextVariables.nome_agente = client.agent_name || '';
      Object.assign(contextVariables, this.withMessageAliases(message));
      if (metadata.variable_schema) {
        contextVariables._variable_schema = metadata.variable_schema;
      }

      if (!resolvedAgentId) {
        const initialAgent = await this.prisma.painel_agents.findFirst({
          where: {
            client_id: clientId,
            is_initial: true,
            is_active: true,
            interaction_mode: { in: ['text', 'both'] },
          },
        });
        if (initialAgent) {
          resolvedAgentId = initialAgent.id;
        } else {
          const firstAgent = await this.prisma.painel_agents.findFirst({
            where: {
              client_id: clientId,
              is_active: true,
              interaction_mode: { in: ['text', 'both'] },
            },
          });
          if (firstAgent) resolvedAgentId = firstAgent.id;
        }
      }

      if (externalUserId) {
        conversationId = await this.resolveConversation({
          clientId,
          companyId,
          originChannel,
          externalUserId,
        });
        // P31: conversation e state sao independentes -> lidas em paralelo,
        // uma unica vez por turno, e reaproveitadas no fim do turno.
        const [record, loadedState] = await Promise.all([
          this.loadConversationRecord(conversationId),
          this.loadState(conversationId),
        ]);
        conversationRecord = record;
        state = loadedState;
        const persistedContext = this.asRecord(
          this.asRecord(conversationRecord?.metadata)[TEST_CHAT_CONTEXT_KEY],
        );
        contextVariables = {
          ...contextVariables,
          ...persistedContext,
        };
        Object.assign(contextVariables, this.withMessageAliases(message));

        const hadPendingAgent = Boolean(state.pending_agent_id);
        resolvedAgentId = await this.resolveAgentId(
          clientId,
          state,
          resolvedAgentId || '',
          persistedContext,
        );
        if (hadPendingAgent) {
          // Consome a transferência pendente para não colar nas próximas mensagens
          state = await this.saveState(
            conversationId,
            { pending_agent_id: null },
            state,
          );
        }
      } else {
        resolvedAgentId = await this.resolveAgentId(
          clientId,
          {},
          resolvedAgentId || '',
          contextVariables,
        );
      }

      let agent: any = null;
      if (resolvedAgentId) {
        agent = await this.prisma.painel_agents.findUnique({
          where: { id: resolvedAgentId },
        });
      }

      if (agent?.interaction_mode === 'voice') {
        throw new Error(
          'Este agente está configurado apenas para atendimento por voz.',
        );
      }

      if (agent) {
        resolvedAgentName = agent.service_step || agent.id;
        resolvedAgentConfig =
          this.apiToolExecutor.buildAgentConfigFromRecord(agent);

        const transitions = agent.transitions || {};
        provider = provider || transitions.llm_provider;
        model = model || agent.model;
        systemPrompt = systemPrompt || agent.system_prompt || undefined;

        const loaded = await this.apiToolExecutor.loadAgentTools({
          clientId,
          agent,
          agentConfig: resolvedAgentConfig,
        });
        apiTools = loaded.apiTools;
        availableTools = loaded.availableTools;
        allClientApiNames = loaded.allClientApiNames;
      }

      // Inferência do provider se não informado explicitamente
      if (!provider && model) {
        if (model.toLowerCase().startsWith('gemini')) {
          provider = 'gemini';
        } else if (
          model.includes('/') ||
          model.toLowerCase().startsWith('llama')
        ) {
          provider = 'groq';
        }
      }

      // Model fallback caso provider exista mas model esteja vazio
      if (!model && provider) {
        if (provider.toLowerCase() === 'gemini') {
          model = 'gemini-2.5-flash';
        } else if (provider.toLowerCase() === 'groq') {
          model = 'llama-3.3-70b-versatile';
        } else if (provider.toLowerCase() === 'openrouter') {
          model = 'google/gemini-2.5-flash';
        }
      }

      if (this.isMaskedOrPlaceholder(apiKey) && provider) {
        apiKey = await this.providerKeyResolver.resolveApiKey(
          clientId || '',
          provider,
        );
      } else if (provider && !this.isMaskedOrPlaceholder(apiKey)) {
        // Prioriza a chave cadastrada pelo cliente no painel (provider_credentials
        // / metadata com descriptografia); a chave recebida é apenas fallback
        const registeredKey = await this.providerKeyResolver.resolveApiKey(
          clientId,
          provider,
        );
        if (registeredKey) apiKey = registeredKey;
      }
    }

    if (this.isMaskedOrPlaceholder(apiKey) && provider) {
      apiKey = await this.providerKeyResolver.resolveApiKey(
        clientId || '',
        provider,
      );
    }

    if (!provider || !model || !apiKey) {
      throw new Error(
        `Configuração incompleta ou chave não encontrada para o provedor "${provider || 'desconhecido'}". Verifique a chave de API em Configurações > Provedores de IA.`,
      );
    }

    if (!conversationId || !clientId || !companyId) {
      const effectiveSystemPrompt = this.buildContextualSystemPrompt(
        systemPrompt,
        contextVariables,
      );
      const startMs = Date.now();
      const result = await this.llmToolLoop.run({
        provider,
        model,
        apiKey,
        onToken,
        message,
        files,
        systemPrompt: effectiveSystemPrompt,
        history: [],
        tools: apiTools,
      });
      const latencyMs = Date.now() - startMs;
      contextVariables = this.apiToolExecutor.mergeToolResults(
        contextVariables,
        result.toolCalls || [],
        apiTools,
        allClientApiNames,
      );
      return {
        ...result,
        debug: {
          externalUserId,
          originChannel,
          provider,
          model,
          agentId: resolvedAgentId || agentId,
          effectiveSystemPrompt,
          rawSystemPrompt: systemPrompt,
          memory: { source: 'none', messagesUsed: 0 },
          contextVariables,
          availableTools,
          toolCalls: result.toolCalls || [],
          usage: result.usage,
          latencyMs,
        },
      };
    }

    const lockKey = `lock:test-chat:${conversationId}`;
    let acquired = await this.redisService.acquireLock(lockKey, 15);
    for (
      let attempt = 0;
      !acquired && attempt < LOCK_RETRY_ATTEMPTS;
      attempt++
    ) {
      // Tentativas rápidas (300ms) no lugar da espera fixa de 1,5s
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      acquired = await this.redisService.acquireLock(lockKey, 15);
    }
    if (!acquired) {
      throw new ConflictException(
        'Conversa em processamento. Tente novamente em instantes.',
      );
    }

    try {
      const memory = await this.loadMemory(conversationId);
      const history = memory.messages;
      const inboundContent =
        message && message.trim()
          ? message
          : files?.some((f) => f.mimeType.startsWith('audio/'))
            ? '[Áudio]'
            : files?.some((f) => f.mimeType.startsWith('image/'))
              ? `[${files.filter((f) => f.mimeType.startsWith('image/')).length} imagem(ns) enviada(s)]`
              : '[Anexo]';

      const inboundMessage = await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'customer',
        direction: 'inbound',
        channel: originChannel,
        content: inboundContent,
      });
      const agentRun = await this.startTestAgentRun({
        companyId,
        clientId,
        conversationId,
        inboundMessageId: inboundMessage.id,
        agentId: resolvedAgentId,
        provider,
        model,
      });

      let result: {
        text: string;
        toolCalls?: ToolCallDebug[];
        transcription?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      };
      const effectiveSystemPrompt = this.buildContextualSystemPrompt(
        systemPrompt,
        contextVariables,
      );
      const startMs = Date.now();
      try {
        result = await this.llmToolLoop.run({
          provider,
          model,
          apiKey,
          onToken,
          message,
          files,
          systemPrompt: effectiveSystemPrompt,
          history,
          tools: apiTools,
          context: this.buildLoopContext(
            resolvedAgentConfig,
            clientId,
            companyId,
            conversationId,
            inboundMessage.id,
            agentRun.id,
          ),
        });
      } catch (error) {
        await this.failTestAgentRun(agentRun.id, error, agentRun.started_at);
        throw error;
      }
      const latencyMs = Date.now() - startMs;

      const audioTranscript = result.transcription;

      if (files?.length && companyId && clientId) {
        for (const file of files) {
          const isAudio = file.mimeType.startsWith('audio/');
          const transcript = isAudio ? audioTranscript || null : null;
          const mediaAsset = await this.mediaService.storeInlineAsset({
            companyId,
            clientId,
            messageId: inboundMessage.id,
            mimeType: file.mimeType,
            data: file.data,
            transcript,
          });
          await this.prisma.message_parts.create({
            data: {
              message_id: inboundMessage.id,
              part_type: isAudio ? 'audio' : 'image',
              media_asset_id: mediaAsset.id,
              text_content: transcript,
            },
          });
        }
      }

      if (audioTranscript) {
        await this.prisma.messages.update({
          where: { id: inboundMessage.id },
          data: {
            content: `[Áudio] ${audioTranscript}`,
          },
        });
      }

      const responseMessage = await this.saveMessage({
        conversationId,
        companyId,
        clientId,
        senderType: 'ai',
        direction: 'outbound',
        channel: originChannel,
        content: result.text,
      });
      await this.completeTestAgentRun({
        agentRunId: agentRun.id,
        responseMessageId: responseMessage.id,
        usage: result.usage,
        model,
        provider,
        startedAt: agentRun.started_at,
      });

      const userMemoryContent = audioTranscript
        ? `[Áudio] ${audioTranscript}`
        : message && message.trim()
          ? message
          : '[Imagem/Documento enviado pelo cliente]';

      await this.saveMemory(conversationId, [
        ...history,
        { role: 'user', content: userMemoryContent },
        { role: 'assistant', content: result.text },
      ]);

      contextVariables = this.apiToolExecutor.mergeToolResults(
        contextVariables,
        result.toolCalls || [],
        apiTools,
        allClientApiNames,
      );
      await this.saveConversationContext(
        conversationId,
        contextVariables,
        this.asRecord(conversationRecord?.metadata),
      );

      if (resolvedAgentId) {
        state = await this.saveState(
          conversationId,
          { current_agent_id: resolvedAgentId },
          state,
        );
      }

      // Transição pós-API: avalia condições de ativação sobre o estado
      // enriquecido com os retornos das APIs executadas neste turno
      if (resolvedAgentId && clientId && companyId) {
        const activation = await this.checkActivationAfterApi(
          clientId,
          resolvedAgentId,
          contextVariables,
        );
        if (activation && activation.mode === 'immediate') {
          const immediateResult = await this.processWithAgent(
            activation.agent,
            clientId,
            companyId,
            conversationId,
            originChannel,
            message,
            inboundMessage.id,
            contextVariables,
            history,
            memory,
            onToken,
          );
          if (immediateResult) {
            const immediateResponseMessage = await this.saveMessage({
              conversationId,
              companyId,
              clientId,
              senderType: 'ai',
              direction: 'outbound',
              channel: originChannel,
              content: immediateResult.result.text,
            });
            await this.completeTestAgentRun({
              agentRunId: immediateResult.agentRunId,
              responseMessageId: immediateResponseMessage.id,
              usage: immediateResult.result.usage,
              model: immediateResult.model,
              provider: immediateResult.provider,
              startedAt: immediateResult.startedAt,
            });
            await this.saveMemory(conversationId, [
              ...history,
              { role: 'user', content: userMemoryContent },
              { role: 'assistant', content: immediateResult.result.text || '' },
            ]);
            immediateResult.contextVariables =
              this.apiToolExecutor.mergeToolResults(
                immediateResult.contextVariables,
                immediateResult.result.toolCalls || [],
                immediateResult.apiTools,
                allClientApiNames,
              );
            await this.saveConversationContext(
              conversationId,
              immediateResult.contextVariables,
              this.asRecord(conversationRecord?.metadata),
            );
            state = await this.saveState(
              conversationId,
              {
                current_agent_id: activation.agent.id,
                pending_agent_id: null,
              },
              state,
            );
            await this.syncPainelInteraction({
              companyId,
              clientId,
              agentId: activation.agent.id,
              agentName: activation.agent.service_step || activation.agent.id,
              sessionId: conversationId,
              channel: originChannel || 'webchat',
              userMessage: inboundContent,
              assistantMessage: immediateResult.result.text,
              contextVariables: immediateResult.contextVariables,
              toolCalls: immediateResult.result.toolCalls || [],
              usage: immediateResult.result.usage,
              provider: immediateResult.provider,
              model: immediateResult.model,
            });

            return {
              ...immediateResult.result,
              agentName: activation.agent.service_step || activation.agent.id,
              debug: {
                conversationId,
                externalUserId,
                originChannel,
                provider,
                model,
                agentId: activation.agent.id,
                effectiveSystemPrompt,
                rawSystemPrompt: systemPrompt,
                memory: {
                  source: memory.source,
                  messagesUsed: history.length,
                },
                contextVariables: immediateResult.contextVariables,
                availableTools: immediateResult.availableTools,
                toolCalls: immediateResult.result.toolCalls || [],
                usage: immediateResult.result.usage,
                latencyMs,
              },
            };
          }
        } else if (activation) {
          // Modo "próxima mensagem": agenda o novo agente para o próximo turno
          state = await this.saveState(
            conversationId,
            {
              current_agent_id: activation.agent.id,
              pending_agent_id: null,
            },
            state,
          );
        }
      }

      let crmRecord: Record<string, unknown> | undefined;
      if (conversationId) {
        try {
          // P31: reaproveita client/conversation/state lidos no início do turno
          // (nenhuma re-leitura de painel_clients, conversations ou
          // conversation_state aqui).
          const freshConv = conversationRecord;

          const clientMeta =
            (client?.metadata as Record<string, unknown>) || {};
          const crmOutputConfig = (clientMeta.crm_output_config as any) || null;

          const combinedState = {
            ...contextVariables,
            ...state,
          };

          // Analytics: avaliação dos marcadores de negócio sobre o estado pós-tool
          if (clientId && companyId) {
            await this.analyticsService.evaluateAndRecord({
              clientId,
              companyId,
              conversationId,
              endUserId: freshConv?.end_user_id || null,
              originChannel: originChannel,
              toolNames: (result.toolCalls || [])
                .map((call: any) => call?.name)
                .filter(
                  (name: unknown): name is string => typeof name === 'string',
                ),
              state: combinedState,
            });
          }

          crmRecord = this.crmDataTransformer.transform({
            sessionState: combinedState,
            endUser: freshConv?.end_users,
            conversation: freshConv,
            config: crmOutputConfig,
          });

          if (freshConv) {
            const existingMeta =
              (freshConv.metadata as Record<string, unknown>) || {};
            await this.prisma.conversations.update({
              where: { id: conversationId },
              data: {
                metadata: {
                  ...existingMeta,
                  // Reconstitui o contexto persistido neste turno
                  // (saveConversationContext) sem reler o documento.
                  [TEST_CHAT_CONTEXT_KEY]: contextVariables,
                  crm_record: crmRecord,
                } as any,
              },
            });
          }
        } catch (crmErr) {
          this.logger.warn(
            { error: (crmErr as Error).message },
            'Falha ao transformar crmRecord no test-chat',
          );
        }
      }

      const finalResponse = {
        ...result,
        agentName: resolvedAgentName,
        debug: {
          conversationId,
          externalUserId,
          originChannel,
          provider,
          model,
          agentId: resolvedAgentId || agentId,
          effectiveSystemPrompt,
          rawSystemPrompt: systemPrompt,
          memory: {
            source: memory.source,
            messagesUsed: history.length,
          },
          contextVariables,
          availableTools,
          toolCalls: result.toolCalls || [],
          usage: result.usage,
          latencyMs,
          crmRecord,
        },
      };

      // Sincroniza interação unificada (painel_interactions)
      await this.syncPainelInteraction({
        companyId,
        clientId,
        agentId: resolvedAgentId || agentId,
        agentName: resolvedAgentName,
        sessionId: conversationId,
        channel: originChannel || 'webchat',
        userMessage: inboundContent,
        assistantMessage: result.text,
        contextVariables,
        toolCalls: result.toolCalls || [],
        usage: result.usage,
        provider,
        model,
      });

      return finalResponse;
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  // ── Sessão e contexto de teste ──────────────────────────────────

  private buildLoopContext(
    agentConfig: AgentConfig | undefined,
    clientId: string,
    companyId: string,
    conversationId: string,
    messageId: string,
    agentRunId: string,
  ): NativeRagRuntimeContext {
    return {
      agentConfig,
      clientId,
      companyId,
      conversationId,
      messageId,
      agentRunId,
    };
  }

  private async resolveConversation(params: {
    clientId: string;
    companyId: string;
    originChannel: string;
    externalUserId: string;
  }) {
    const lockKey = `lock:test-chat-identity:${params.clientId}:${params.originChannel}:${params.externalUserId}`;
    const acquired = await this.redisService.acquireLock(lockKey, 30);
    if (!acquired) {
      throw new Error('Sessao em criacao. Tente novamente em instantes.');
    }

    try {
      const identity = await this.prisma.channel_identities.findFirst({
        where: {
          client_id: params.clientId,
          channel_type: params.originChannel,
          external_user_id: params.externalUserId,
        },
        select: { end_user_id: true },
      });

      let endUserId = identity?.end_user_id;
      if (!endUserId) {
        const endUser = await this.prisma.end_users.create({
          data: {
            company_id: params.companyId,
            client_id: params.clientId,
            metadata: { source: 'enterprise_chat_test' },
          },
        });
        endUserId = endUser.id;

        await this.prisma.channel_identities.create({
          data: {
            company_id: params.companyId,
            client_id: params.clientId,
            end_user_id: endUserId,
            channel_type: params.originChannel,
            external_user_id: params.externalUserId,
          },
        });
      }

      const existing = await this.prisma.conversations.findFirst({
        where: {
          client_id: params.clientId,
          origin_channel: params.originChannel,
          end_user_id: endUserId,
          status: { not: 'closed' },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      });
      if (existing) return existing.id;

      const conversation = await this.prisma.conversations.create({
        data: {
          company_id: params.companyId,
          client_id: params.clientId,
          end_user_id: endUserId,
          origin_channel: params.originChannel,
          external_conversation_key: `${params.originChannel}:${params.externalUserId}`,
          status: 'active',
          mode: 'auto',
          metadata: { source: 'enterprise_chat_test' },
        },
        select: { id: true },
      });

      return conversation.id;
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  private sanitizeContextVariables(metadata: Record<string, unknown>) {
    const {
      llm_providers,
      llm_providers_updated_at,
      [TEST_CHAT_CONTEXT_KEY]: _testChatContext,
      ...safeMetadata
    } = metadata || {};
    return safeMetadata;
  }

  /**
   * P31: leitura única da conversa por turno (com end_users para o bloco de
   * CRM/analytics). O resultado é cacheado em `conversationRecord` no send().
   */
  private loadConversationRecord(conversationId: string) {
    return this.prisma.conversations.findUnique({
      where: { id: conversationId },
      include: { end_users: true },
    });
  }

  /**
   * P31: leitura única do client por turno. O resultado é cacheado em
   * `client` no send() e reutilizado no bloco de CRM.
   */
  private loadPainelClient(clientId: string) {
    return this.prisma.painel_clients.findUnique({
      where: { id: clientId },
    });
  }

  private async saveConversationContext(
    conversationId: string,
    contextVariables: Record<string, unknown>,
    existingMetadata?: Record<string, any>,
  ) {
    // P31: quando o caller já tem o metadata carregado no turno, evita a
    // re-leitura da conversa antes do update.
    const metadata =
      existingMetadata ??
      this.asRecord(
        (
          await this.prisma.conversations.findUnique({
            where: { id: conversationId },
            select: { metadata: true },
          })
        )?.metadata,
      );

    const nextMetadata = {
      ...metadata,
      [TEST_CHAT_CONTEXT_KEY]: contextVariables,
    } as Prisma.InputJsonObject;

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        metadata: nextMetadata,
      },
    });
  }

  private async loadState(
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    const cs = await this.prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
    });
    return (cs?.state as Record<string, unknown>) || {};
  }

  /**
   * P31: grava o state sem reler `conversation_state` — o caller repassa o
   * estado já carregado no turno (`existingState`), mantendo o merge idêntico
   * ao comportamento anterior. Retorna o estado mesclado.
   */
  private async saveState(
    conversationId: string,
    partialState: Record<string, unknown>,
    existingState?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const merged = {
      ...((existingState as Record<string, unknown>) || {}),
      ...partialState,
    };
    await this.prisma.conversation_state.upsert({
      where: { conversation_id: conversationId },
      update: { state: merged as any, version: { increment: 1 } },
      create: {
        conversation_id: conversationId,
        state: merged as any,
      },
    });
    return merged;
  }

  private async resolveAgentId(
    clientId: string,
    state: Record<string, unknown>,
    defaultAgentId: string,
    contextVariables: Record<string, unknown>,
  ): Promise<string> {
    const mergedState = { ...contextVariables, ...state };

    const allAgents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        is_initial: true,
        activation_conditions: true,
        activation_mode: true,
        interaction_mode: true,
      },
      orderBy: { execution_order: 'asc' },
    });
    const agents = allAgents.filter(
      (agent) => agent.interaction_mode !== 'voice',
    );

    if (agents.length === 0) return defaultAgentId;

    // Sem avaliação de condições aqui: a primeira mensagem sempre vai para o
    // agente inicial e as condições só são avaliadas após retorno de APIs.
    // Fluxo: pendente (transferência pós-API) > atual > inicial.

    const pendingAgentId = mergedState.pending_agent_id as string | undefined;
    if (pendingAgentId) {
      const target = agents.find((a) => a.id === pendingAgentId);
      if (target) return target.id;
    }

    const currentAgentId =
      (mergedState.current_agent_id as string) || defaultAgentId;
    const currentAgent = agents.find((a) => a.id === currentAgentId);
    if (currentAgent) return currentAgent.id;

    return (agents.find((a) => a.is_initial) || agents[0]).id;
  }

  /**
   * Avalia as condições de ativação dos outros agentes após o retorno de uma
   * API/tool sobre o estado enriquecido. Retorna o primeiro agente (por
   * execution_order) cujas condições foram satisfeitas e seu modo de ativação.
   */
  private async checkActivationAfterApi(
    clientId: string,
    currentAgentId: string,
    contextVariables: Record<string, unknown>,
  ): Promise<{ agent: any; mode: string } | null> {
    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        model: true,
        system_prompt: true,
        transitions: true,
        allowed_tool_names: true,
        activation_conditions: true,
        activation_mode: true,
        interaction_mode: true,
      },
      orderBy: { execution_order: 'asc' },
    });

    for (const agent of agents) {
      if (agent.id === currentAgentId || agent.interaction_mode === 'voice') {
        continue;
      }
      const conditions =
        agent.activation_conditions as ActivationConditionGroup | null;
      if (!conditions?.conditions?.length) continue;
      const evaluation = evaluateConditionsWithDetails(
        conditions,
        contextVariables,
      );
      if (evaluation.matched) {
        return { agent, mode: agent.activation_mode || 'on_next_message' };
      }
      this.logger.debug(
        `Condição de ativação não atendida para "${agent.service_step}": ${describeEvaluation(evaluation)}`,
      );
    }

    return null;
  }

  private async processWithAgent(
    agent: any,
    clientId: string,
    companyId: string,
    conversationId: string,
    _originChannel: string,
    message: string,
    inboundMessageId: string,
    contextVariables: Record<string, unknown>,
    history: MemoryMessage[],
    _memory: any,
    onToken?: (chunk: string) => void,
  ) {
    const transitions = agent.transitions || {};
    const provider =
      transitions.llm_provider || process.env.LLM_PROVIDER || 'groq';
    const model = agent.model || 'openai/gpt-oss-120b';

    // Sempre usa a chave cadastrada pelo cliente (provider_credentials / metadata
    // com descriptografia), caindo para variáveis de ambiente apenas se necessário
    let apiKey = await this.providerKeyResolver.resolveApiKey(
      clientId,
      provider,
    );
    if (!apiKey) {
      const envKeyName = `${provider.toUpperCase()}_API_KEY`;
      apiKey = process.env[envKeyName] || '';
    }
    if (!apiKey) {
      this.logger.warn(
        { provider },
        'processWithAgent: API Key nao encontrada para provider',
      );
      return null;
    }

    const agentConfig = this.apiToolExecutor.buildAgentConfigFromRecord(agent);
    const { apiTools, availableTools } =
      await this.apiToolExecutor.loadAgentTools({
        clientId,
        agent,
        agentConfig,
      });

    const agentRun = await this.startTestAgentRun({
      companyId,
      clientId,
      conversationId,
      inboundMessageId,
      agentId: agent.id,
      provider,
      model,
    });

    try {
      const result = await this.llmToolLoop.run({
        provider,
        model,
        apiKey,
        onToken,
        message,
        systemPrompt: this.buildContextualSystemPrompt(
          agent.system_prompt || undefined,
          contextVariables,
        ),
        history,
        tools: apiTools,
        context: this.buildLoopContext(
          agentConfig,
          clientId,
          companyId,
          conversationId,
          inboundMessageId,
          agentRun.id,
        ),
      });

      return {
        result,
        agentRunId: agentRun.id,
        model,
        provider,
        startedAt: agentRun.started_at,
        apiTools,
        availableTools,
        contextVariables,
      };
    } catch (error) {
      await this.failTestAgentRun(agentRun.id, error, agentRun.started_at);
      throw error;
    }
  }

  // ── Prompt e contexto ───────────────────────────────────────────

  private buildContextualSystemPrompt(
    systemPrompt: string | undefined,
    contextVariables: Record<string, unknown>,
  ) {
    const schema =
      (contextVariables._variable_schema as Record<string, unknown>) || null;
    let crmInstruction = '';
    if (schema && Array.isArray(schema.fields) && schema.fields.length > 0) {
      const fieldList = schema.fields
        .map(
          (f: any) =>
            `- ${f.key} (${f.label || f.key}, tipo: ${f.type || 'text'}${f.required ? ', OBRIGATÓRIO' : ''})${f.description ? ': ' + f.description : ''}`,
        )
        .join('\n');

      crmInstruction = `\n\n[DIRETRIZES DE CRM & COLETA DE DADOS - OPERAÇÃO: ${String(schema.operation_type || 'GERAL').toUpperCase()}]\nColete ou confirme os seguintes campos durante o atendimento (eles são persistidos automaticamente no CRM pela plataforma):\n${fieldList}\nSempre que o cliente fornecer um desses dados, confirme-o claramente na conversa e, se houver uma API disponível para registrá-lo, utilize-a.`;
    }

    const entries = Object.entries(contextVariables).filter(
      ([key, value]) => value !== undefined && !key.startsWith('_'),
    );

    const basePrompt = (systemPrompt || '') + crmInstruction;
    const conditionalResolved = resolveConditionalString(
      basePrompt,
      contextVariables || {},
    );
    const replacedPrompt = resolvePromptTemplateString(
      conditionalResolved,
      contextVariables || {},
    );

    if (!entries.length) return replacedPrompt;

    const contextBlock = entries
      .map(([key, value]) => `- {{${key}}}: ${this.formatContextValue(value)}`)
      .join('\n');

    return [
      replacedPrompt,
      'Contexto persistido desta conversa:',
      contextBlock,
      'Use esses valores como memoria de trabalho quando forem relevantes para a resposta.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private isMaskedOrPlaceholder(k?: string | null) {
    return (
      !k ||
      k.trim() === '' ||
      k === 'stored' ||
      k === 'undefined' ||
      k === 'null' ||
      k.includes('***') ||
      k.includes('...') ||
      k.startsWith('enc:')
    );
  }

  private withMessageAliases(message: string): Record<string, unknown> {
    return {
      mensagem_usuario: message,
      user_message: message,
      last_message: message,
      message,
      text: message,
      texto: message,
      user_transcript: message,
    };
  }

  private formatContextValue(value: unknown) {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private asRecord(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  // ── Memória Redis do test chat ──────────────────────────────────

  private async loadMemory(conversationId: string): Promise<{
    source: 'redis' | 'database' | 'none';
    messages: MemoryMessage[];
  }> {
    const key = this.memoryKey(conversationId);
    const cached = await this.redisService.get<MemoryMessage[]>(key);
    if (cached?.length) {
      return { source: 'redis', messages: cached.slice(-this.memoryLimit) };
    }

    const messages = await this.prisma.messages.findMany({
      where: {
        conversation_id: conversationId,
        content: { not: null },
        sender_type: { in: ['customer', 'ai'] },
      },
      orderBy: { created_at: 'desc' },
      take: this.memoryLimit,
      select: { sender_type: true, content: true },
    });

    const history = messages
      .reverse()
      .map((item) => ({
        role: item.sender_type === 'ai' ? 'assistant' : 'user',
        content: item.content || '',
      }))
      .filter((item) => item.content) as MemoryMessage[];

    if (history.length) await this.saveMemory(conversationId, history);
    return {
      source: history.length ? 'database' : 'none',
      messages: history,
    };
  }

  private async saveMemory(conversationId: string, history: MemoryMessage[]) {
    await this.redisService.set(
      this.memoryKey(conversationId),
      history.filter((item) => item.content).slice(-this.memoryLimit),
    );
  }

  private memoryKey(conversationId: string) {
    return `memory:test-chat:${conversationId}`;
  }

  // ── Agent runs e persistência de mensagens ──────────────────────

  private async startTestAgentRun(params: {
    companyId: string;
    clientId: string;
    conversationId: string;
    inboundMessageId: string;
    agentId?: string;
    provider?: string;
    model?: string;
  }) {
    return this.prisma.agent_runs.create({
      data: {
        company_id: params.companyId,
        client_id: params.clientId,
        conversation_id: params.conversationId,
        inbound_message_id: params.inboundMessageId,
        agent_id: params.agentId || null,
        provider: params.provider || null,
        model: params.model || null,
        status: 'running',
        started_at: new Date(),
        trace: { source: 'enterprise_chat_test' } as any,
      },
    });
  }

  private async completeTestAgentRun(params: {
    agentRunId: string;
    responseMessageId?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    model?: string;
    provider?: string;
    startedAt?: Date | null;
  }) {
    const inputTokens = params.usage?.input_tokens ?? 0;
    const outputTokens = params.usage?.output_tokens ?? 0;
    const totalTokens =
      params.usage?.total_tokens ?? inputTokens + outputTokens;
    const cost = this.modelPricingService.calculateTokenCost({
      provider: params.provider,
      model: params.model,
      inputTokens,
      outputTokens,
    });

    const latencyMs = params.startedAt
      ? Date.now() - new Date(params.startedAt).getTime()
      : null;

    await this.prisma.agent_runs.update({
      where: { id: params.agentRunId },
      data: {
        response_message_id: params.responseMessageId || null,
        status: 'success',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost,
        latency_ms: latencyMs,
        completed_at: new Date(),
      },
    });
  }

  private async failTestAgentRun(
    agentRunId: string,
    error: unknown,
    startedAt?: Date | null,
  ) {
    const latencyMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : null;

    await this.prisma.agent_runs.update({
      where: { id: agentRunId },
      data: {
        status: 'failed',
        error_message:
          error instanceof Error ? error.message : 'Erro ao executar agente',
        latency_ms: latencyMs,
        completed_at: new Date(),
      },
    });
  }

  private async saveMessage(params: {
    conversationId: string;
    companyId: string;
    clientId: string;
    senderType: string;
    direction: string;
    channel: string;
    content: string;
  }) {
    const message = await this.prisma.messages.create({
      data: {
        conversation_id: params.conversationId,
        company_id: params.companyId,
        sender_type: params.senderType,
        channel: params.channel,
        direction: params.direction,
        message_type: 'text',
        content: params.content,
        metadata: { source: 'enterprise_chat_test' },
        status: params.direction === 'inbound' ? 'received' : 'completed',
      },
      select: { id: true },
    });

    const now = new Date();
    await this.prisma.conversations.update({
      where: { id: params.conversationId },
      data: {
        last_message_at: now,
        ...(params.direction === 'inbound'
          ? { last_inbound_at: now }
          : { last_outbound_at: now }),
      },
    });

    return message;
  }

  // ── Sincronização com painel_interactions ───────────────────────

  private async syncPainelInteraction(params: {
    companyId: string;
    clientId: string;
    agentId?: string;
    agentName?: string;
    sessionId: string;
    channel: string;
    userMessage?: string;
    assistantMessage?: string;
    contextVariables?: Record<string, any>;
    toolCalls?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    provider?: string;
    model?: string;
  }) {
    try {
      const vars = params.contextVariables || {};
      const isRightParty = !!(
        vars.cliente_cpf ||
        vars.cpf ||
        vars.cliente_nome
      );
      const debtAmount = vars.valor_divida ? Number(vars.valor_divida) : null;
      const isDebtPresented = debtAmount !== null && debtAmount > 0;
      const isAgreementReached = !!(vars.acordo_confirmado || vars.acordo_id);
      const isPromiseToPay = !!(vars.promessa_pagamento || vars.data_promessa);

      let disposition = 'IN_PROGRESS';
      if (isAgreementReached) disposition = 'AGREEMENT_CLOSED';
      else if (isPromiseToPay) disposition = 'PTP';
      else if (isDebtPresented) disposition = 'DEBT_PRESENTED';
      else if (isRightParty) disposition = 'RPC_NO_DEAL';
      else if (params.userMessage) disposition = 'HUMAN_ANSWERED';

      const existing = await this.prisma.painel_interactions.findUnique({
        where: { session_id: params.sessionId },
      });

      const currentMessages = Array.isArray(existing?.messages)
        ? (existing.messages as any[])
        : [];

      const newMsgs = [...currentMessages];
      const now = new Date();

      if (params.userMessage) {
        newMsgs.push({
          id: `msg_u_${Date.now()}`,
          role: 'user',
          content: params.userMessage,
          timestamp: now.toISOString(),
        });
      }

      if (params.assistantMessage) {
        newMsgs.push({
          id: `msg_a_${Date.now()}`,
          role: 'assistant',
          content: params.assistantMessage,
          tool_calls: params.toolCalls || [],
          timestamp: new Date(now.getTime() + 100).toISOString(),
        });
      }

      // F2.5/P31: teto no array persistido (últimas N mensagens) e escrita
      // ignorada quando nada mudou (mesmo tamanho e mesmo último item).
      const cappedMessages = newMsgs.slice(-PAINEL_MESSAGES_LIMIT);
      const messagesUnchanged =
        cappedMessages.length === currentMessages.length &&
        JSON.stringify(cappedMessages[cappedMessages.length - 1]) ===
          JSON.stringify(currentMessages[currentMessages.length - 1]);
      if (messagesUnchanged) return;

      const totalTokens =
        (existing?.total_tokens || 0) + (params.usage?.total_tokens || 0);
      const promptTokens =
        (existing?.prompt_tokens || 0) + (params.usage?.input_tokens || 0);
      const completionTokens =
        (existing?.completion_tokens || 0) + (params.usage?.output_tokens || 0);

      const clientIdentifier =
        (vars.cliente_cpf as string) ||
        (vars.cpf as string) ||
        existing?.client_identifier ||
        null;
      const clientName =
        (vars.cliente_nome as string) || existing?.client_name || null;

      await this.prisma.painel_interactions.upsert({
        where: { session_id: params.sessionId },
        create: {
          company_id: params.companyId,
          client_id: params.clientId,
          agent_id: params.agentId,
          agent_name: params.agentName,
          session_id: params.sessionId,
          channel: params.channel || 'webchat',
          direction: 'inbound',
          interaction_mode: 'both',
          client_identifier: clientIdentifier,
          client_name: clientName,
          has_human_answer: true,
          human_answered_at: existing?.human_answered_at || now,
          is_right_party: isRightParty,
          right_party_at: isRightParty ? existing?.right_party_at || now : null,
          is_debt_presented: isDebtPresented,
          debt_presented_at: isDebtPresented
            ? existing?.debt_presented_at || now
            : null,
          debt_amount: debtAmount !== null ? (debtAmount as any) : null,
          is_agreement_reached: isAgreementReached,
          agreement_at: isAgreementReached
            ? existing?.agreement_at || now
            : null,
          agreement_id: (vars.acordo_id as string) || null,
          agreement_amount: vars.valor_total
            ? Number(vars.valor_total)
            : debtAmount !== null
              ? (debtAmount as any)
              : null,
          is_promise_to_pay: isPromiseToPay,
          promise_to_pay_at: isPromiseToPay
            ? existing?.promise_to_pay_at || now
            : null,
          disposition,
          service_step: vars.service_step || null,
          llm_provider: params.provider,
          llm_model: params.model,
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          context_variables: vars as any,
          messages: cappedMessages as any,
          started_at: existing?.started_at || now,
          status: isAgreementReached ? 'completed' : 'ongoing',
        },
        update: {
          agent_id: params.agentId || existing?.agent_id,
          agent_name: params.agentName || existing?.agent_name,
          client_identifier: clientIdentifier || existing?.client_identifier,
          client_name: clientName || existing?.client_name,
          has_human_answer: true,
          is_right_party: isRightParty || existing?.is_right_party || false,
          right_party_at: isRightParty
            ? existing?.right_party_at || now
            : existing?.right_party_at,
          is_debt_presented:
            isDebtPresented || existing?.is_debt_presented || false,
          debt_presented_at: isDebtPresented
            ? existing?.debt_presented_at || now
            : existing?.debt_presented_at,
          debt_amount:
            debtAmount !== null ? (debtAmount as any) : existing?.debt_amount,
          is_agreement_reached:
            isAgreementReached || existing?.is_agreement_reached || false,
          agreement_at: isAgreementReached
            ? existing?.agreement_at || now
            : existing?.agreement_at,
          agreement_id:
            (vars.acordo_id as string) || existing?.agreement_id || null,
          is_promise_to_pay:
            isPromiseToPay || existing?.is_promise_to_pay || false,
          promise_to_pay_at: isPromiseToPay
            ? existing?.promise_to_pay_at || now
            : existing?.promise_to_pay_at,
          disposition,
          llm_provider: params.provider || existing?.llm_provider,
          llm_model: params.model || existing?.llm_model,
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          context_variables: vars as any,
          messages: cappedMessages as any,
          status: isAgreementReached
            ? 'completed'
            : existing?.status || 'ongoing',
          ended_at: isAgreementReached ? now : existing?.ended_at,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao sincronizar painel_interactions no test-chat: ${err}`,
      );
    }
  }
}
