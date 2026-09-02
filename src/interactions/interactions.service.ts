import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateInteractionDto } from './dto/create-interaction.dto';
import { UpdateInteractionDto } from './dto/update-interaction.dto';

export interface InteractionMessageItem {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  audio_url?: string | null;
  duration_ms?: number;
  interrupted?: boolean;
  interrupted_at_ms?: number;
  barge_in_latency_ms?: number;
  tool_calls?: any[];
  latency_ms?: number;
  timestamp?: string | Date;
}

@Injectable()
export class InteractionsService {
  private readonly logger = new Logger(InteractionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Localiza uma interação existente pela session_id ou cria uma nova
   */
  async findOrCreateSession(dto: CreateInteractionDto) {
    const existing = await this.prisma.painel_interactions.findUnique({
      where: { session_id: dto.session_id },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.painel_interactions.create({
      data: {
        company_id: dto.company_id,
        client_id: dto.client_id,
        agent_id: dto.agent_id,
        session_id: dto.session_id,
        channel: dto.channel || 'webchat',
        direction: dto.direction || 'inbound',
        interaction_mode: dto.interaction_mode || 'both',
        client_identifier: dto.client_identifier,
        company_identifier: dto.company_identifier,
        client_name: dto.client_name,
        agent_name: dto.agent_name,
        context_variables: (dto.context_variables || {}) as any,
        messages: (dto.messages || []) as any,
        started_at: new Date(),
        status: 'ongoing',
      },
    });
  }

  /**
   * Adiciona uma mensagem ao histórico da sessão
   */
  async appendMessage(sessionId: string, message: InteractionMessageItem) {
    try {
      const exists = await this.prisma.painel_interactions.findUnique({
        where: { session_id: sessionId },
        select: { id: true },
      });

      if (!exists) {
        this.logger.warn(
          `Interação não encontrada para session_id: ${sessionId}`,
        );
        return null;
      }

      const newMsg = {
        id:
          message.id ||
          `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        role: message.role,
        content: message.content,
        audio_url: message.audio_url || null,
        duration_ms: message.duration_ms,
        interrupted: !!message.interrupted,
        interrupted_at_ms: message.interrupted_at_ms,
        barge_in_latency_ms: message.barge_in_latency_ms,
        tool_calls: message.tool_calls || [],
        latency_ms: message.latency_ms,
        timestamp: message.timestamp || new Date().toISOString(),
      };

      const isUserMessage = message.role === 'user';

      // Append atômico no JSONB: turnos concorrentes não perdem mensagens
      const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        UPDATE painel_interactions
        SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify(newMsg)}::jsonb,
            has_human_answer = COALESCE(has_human_answer, false) OR ${isUserMessage},
            human_answered_at = CASE
              WHEN COALESCE(has_human_answer, false) = false AND ${isUserMessage} THEN NOW()
              ELSE human_answered_at
            END
        WHERE session_id = ${sessionId}
        RETURNING *
      `);

      return rows?.[0] ?? null;
    } catch (err) {
      this.logger.error(
        `Erro ao anexar mensagem na interação (${sessionId}): ${err}`,
      );
      return null;
    }
  }

  /**
   * Registra um corte de fala / interrupção (barge-in) da IA
   */
  async recordBargeIn(sessionId: string, bargeInLatencyMs?: number) {
    try {
      const exists = await this.prisma.painel_interactions.findUnique({
        where: { session_id: sessionId },
        select: { id: true },
      });

      if (!exists) return null;

      const latency =
        bargeInLatencyMs !== undefined ? Math.trunc(bargeInLatencyMs) : null;

      // Incremento e média calculados atomicamente no banco
      const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        UPDATE painel_interactions
        SET barge_in_count = COALESCE(barge_in_count, 0) + 1,
            avg_barge_in_latency_ms = CASE
              WHEN ${latency}::int IS NOT NULL AND ${latency}::int > 0 THEN
                ROUND(
                  (COALESCE(NULLIF(avg_barge_in_latency_ms, 0), ${latency}::int)::numeric
                    * COALESCE(barge_in_count, 0) + ${latency}::int)
                  / (COALESCE(barge_in_count, 0) + 1)
                )::int
              ELSE avg_barge_in_latency_ms
            END
        WHERE session_id = ${sessionId}
        RETURNING *
      `);

      return rows?.[0] ?? null;
    } catch (err) {
      this.logger.error(`Erro ao registrar barge-in (${sessionId}): ${err}`);
      return null;
    }
  }

  /**
   * Atualiza dados de funil de cobrança e contexto da sessão
   */
  async updateSession(sessionId: string, dto: UpdateInteractionDto) {
    try {
      const dataToUpdate: any = { ...dto };

      // Se passou context_variables, mescla com as existentes
      if (dto.context_variables) {
        const interaction = await this.prisma.painel_interactions.findUnique({
          where: { session_id: sessionId },
          select: { context_variables: true },
        });
        const currentVars =
          (interaction?.context_variables as Record<string, any>) || {};
        dataToUpdate.context_variables = {
          ...currentVars,
          ...dto.context_variables,
        };
      }

      // Converte datas para Date
      if (dto.human_answered_at)
        dataToUpdate.human_answered_at = new Date(dto.human_answered_at);
      if (dto.right_party_at)
        dataToUpdate.right_party_at = new Date(dto.right_party_at);
      if (dto.debt_presented_at)
        dataToUpdate.debt_presented_at = new Date(dto.debt_presented_at);
      if (dto.agreement_at)
        dataToUpdate.agreement_at = new Date(dto.agreement_at);
      if (dto.promise_to_pay_at)
        dataToUpdate.promise_to_pay_at = new Date(dto.promise_to_pay_at);
      if (dto.promise_due_date)
        dataToUpdate.promise_due_date = new Date(dto.promise_due_date);
      if (dto.started_at) dataToUpdate.started_at = new Date(dto.started_at);
      if (dto.ended_at) dataToUpdate.ended_at = new Date(dto.ended_at);

      return await this.prisma.painel_interactions.update({
        where: { session_id: sessionId },
        data: dataToUpdate,
      });
    } catch (err) {
      this.logger.error(`Erro ao atualizar interação (${sessionId}): ${err}`);
      return null;
    }
  }

  /**
   * Encerra a interação consolidando dados finais
   */
  async finalizeSession(
    sessionId: string,
    finalData?: Partial<UpdateInteractionDto>,
  ) {
    const payload: UpdateInteractionDto = {
      ...finalData,
      status: finalData?.status || 'completed',
      ended_at: new Date(),
    };
    return this.updateSession(sessionId, payload);
  }

  /**
   * Lista interações de um cliente com paginação e filtros
   */
  async listInteractions(
    clientId: string,
    filters: {
      channel?: string;
      status?: string;
      is_right_party?: boolean;
      is_agreement_reached?: boolean;
      is_promise_to_pay?: boolean;
      disposition?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = { client_id: clientId };

    if (filters.channel) where.channel = filters.channel;
    if (filters.status) where.status = filters.status;
    if (filters.disposition) where.disposition = filters.disposition;
    if (filters.is_right_party !== undefined)
      where.is_right_party = filters.is_right_party;
    if (filters.is_agreement_reached !== undefined)
      where.is_agreement_reached = filters.is_agreement_reached;
    if (filters.is_promise_to_pay !== undefined)
      where.is_promise_to_pay = filters.is_promise_to_pay;

    if (filters.search) {
      where.OR = [
        {
          client_identifier: { contains: filters.search, mode: 'insensitive' },
        },
        { client_name: { contains: filters.search, mode: 'insensitive' } },
        { agreement_id: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.painel_interactions.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.painel_interactions.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  /**
   * Obtém métricas consolidadas do funil de atendimento e cobrança
   */
  async getFunnelMetrics(clientId: string, startDate?: Date, endDate?: Date) {
    const where: any = { client_id: clientId };
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at.gte = startDate;
      if (endDate) where.created_at.lte = endDate;
    }

    const [
      total,
      humanAnswers,
      rightParties,
      debtsPresented,
      agreementsReached,
      promisesToPay,
      bargeInAggregate,
    ] = await Promise.all([
      this.prisma.painel_interactions.count({ where }),
      this.prisma.painel_interactions.count({
        where: { ...where, has_human_answer: true },
      }),
      this.prisma.painel_interactions.count({
        where: { ...where, is_right_party: true },
      }),
      this.prisma.painel_interactions.count({
        where: { ...where, is_debt_presented: true },
      }),
      this.prisma.painel_interactions.count({
        where: { ...where, is_agreement_reached: true },
      }),
      this.prisma.painel_interactions.count({
        where: { ...where, is_promise_to_pay: true },
      }),
      this.prisma.painel_interactions.aggregate({
        where,
        _sum: {
          barge_in_count: true,
          duration_seconds: true,
          total_tokens: true,
        },
        _avg: {
          avg_barge_in_latency_ms: true,
          avg_first_byte_latency_ms: true,
        },
      }),
    ]);

    const rpcRate = humanAnswers > 0 ? (rightParties / humanAnswers) * 100 : 0;
    const pitchRate =
      rightParties > 0 ? (debtsPresented / rightParties) * 100 : 0;
    const agreementRate =
      rightParties > 0 ? (agreementsReached / rightParties) * 100 : 0;
    const promiseRate =
      rightParties > 0 ? (promisesToPay / rightParties) * 100 : 0;

    return {
      total_interactions: total,
      human_answers: humanAnswers,
      cpc_count: rightParties,
      right_parties: rightParties,
      cpca_count: debtsPresented,
      debts_presented: debtsPresented,
      agreements_reached: agreementsReached,
      promises_to_pay: promisesToPay,
      rates: {
        cpc_rate_pct: Number(rpcRate.toFixed(2)),
        rpc_rate_pct: Number(rpcRate.toFixed(2)),
        cpca_rate_pct: Number(pitchRate.toFixed(2)),
        pitch_rate_pct: Number(pitchRate.toFixed(2)),
        agreement_conversion_pct: Number(agreementRate.toFixed(2)),
        promise_rate_pct: Number(promiseRate.toFixed(2)),
      },
      voice_telemetry: {
        total_barge_in_count: bargeInAggregate._sum.barge_in_count || 0,
        avg_barge_in_latency_ms: Math.round(
          bargeInAggregate._avg.avg_barge_in_latency_ms || 0,
        ),
        avg_first_byte_latency_ms: Math.round(
          bargeInAggregate._avg.avg_first_byte_latency_ms || 0,
        ),
        total_duration_sec: bargeInAggregate._sum.duration_seconds || 0,
        total_tokens: bargeInAggregate._sum.total_tokens || 0,
      },
    };
  }
}
