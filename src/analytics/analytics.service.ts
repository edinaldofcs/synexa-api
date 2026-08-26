import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  ActivationConditionGroup,
} from '../orchestrator/utils/condition-evaluator.util';
import type {
  AnalyticsConfigPayload,
  BusinessMarkerDto,
} from './dto/analytics.dto';

interface EvaluateParams {
  clientId: string;
  companyId: string;
  conversationId?: string;
  endUserId?: string | null;
  originChannel?: string | null;
  /** Nomes das ferramentas executadas neste turno (se houver) */
  toolNames?: string[];
  toolOk?: boolean;
  /** Estado da sessão enriquecido com o retorno das ferramentas */
  state: Record<string, unknown>;
}

const ANALYTICS_CONFIG_KEY = 'analytics_config';
/** Cache curto da config por cliente para evitar leitura de metadata a cada turno */
const CONFIG_CACHE_TTL_MS = 30_000;

export interface MarkerTotal {
  code: string;
  label: string;
  count: number;
  sums: Record<string, number>;
  lastAt: string | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private configCache = new Map<
    string,
    { config: AnalyticsConfigPayload; loadedAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  // ── Configuração ────────────────────────────────────────────────

  async getConfig(clientId: string): Promise<AnalyticsConfigPayload> {
    const cached = this.configCache.get(clientId);
    if (cached && Date.now() - cached.loadedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });
    const meta = (client?.metadata as Record<string, unknown>) || {};
    const config = (meta[ANALYTICS_CONFIG_KEY] as AnalyticsConfigPayload) || {
      markers: [],
      funnel: [],
    };

    const normalized: AnalyticsConfigPayload = {
      markers: Array.isArray(config.markers) ? config.markers : [],
      funnel: Array.isArray(config.funnel) ? config.funnel : [],
    };
    this.configCache.set(clientId, {
      config: normalized,
      loadedAt: Date.now(),
    });
    return normalized;
  }

  async saveConfig(
    clientId: string,
    companyId: string,
    config: AnalyticsConfigPayload,
  ): Promise<AnalyticsConfigPayload> {
    const client = await this.prisma.painel_clients.findFirst({
      where: { id: clientId, company_id: companyId },
      select: { metadata: true },
    });
    if (!client) throw new Error('Cliente não encontrado');

    const meta = ((client.metadata as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >;
    const normalized: AnalyticsConfigPayload = {
      markers: config.markers ?? [],
      funnel: (config.funnel ?? []).filter((code) =>
        (config.markers ?? []).some((m) => m.code === code),
      ),
    };

    await this.prisma.painel_clients.update({
      where: { id: clientId },
      data: {
        metadata: { ...meta, [ANALYTICS_CONFIG_KEY]: normalized } as any,
      },
    });

    this.configCache.set(clientId, {
      config: normalized,
      loadedAt: Date.now(),
    });
    return normalized;
  }

  invalidateConfigCache(clientId?: string) {
    if (clientId) this.configCache.delete(clientId);
    else this.configCache.clear();
  }

  // ── Avaliação e registro de eventos ─────────────────────────────

  /**
   * Avalia os marcadores do cliente sobre o estado pós-tool da conversa.
   * Nunca lança — falhas são logadas e ignoradas para não afetar o atendimento.
   */
  async evaluateAndRecord(params: EvaluateParams): Promise<void> {
    try {
      const { markers } = await this.getConfig(params.clientId);
      if (!markers.length) return;

      for (const marker of markers) {
        try {
          await this.evaluateMarker(marker, params);
        } catch (markerErr) {
          this.logger.warn(
            `Erro ao avaliar marcador "${marker.code}": ${(markerErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Analytics: falha ao carregar configuração: ${(err as Error).message}`,
      );
    }
  }

  private async evaluateMarker(
    marker: BusinessMarkerDto,
    params: EvaluateParams,
  ) {
    // Gatilho por ferramenta
    if (marker.trigger?.tool) {
      if (!params.toolNames?.length) return;
      if (!params.toolNames.includes(marker.trigger.tool)) return;
      if (params.toolOk === false) return;
    }

    // Condições sobre o estado da sessão
    if (marker.conditions?.length) {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: marker.conditions as ActivationConditionGroup['conditions'],
      };
      const evaluation = evaluateConditionsWithDetails(group, params.state);
      if (!evaluation.matched) {
        this.logger.debug(
          `Marcador "${marker.code}" não disparou: ${describeEvaluation(evaluation)}`,
        );
        return;
      }
    }

    if (!marker.trigger?.tool && !marker.conditions?.length) return;

    // Captura de variáveis
    const values: Record<string, unknown> = {};
    for (const key of marker.capture || []) {
      const value = params.state[key];
      if (value !== undefined && value !== null && typeof value !== 'object') {
        values[key] = value;
      }
    }

    // Upset idempotente: um evento por conversa/marcador
    if (params.conversationId) {
      const existing = await this.prisma.business_events.findFirst({
        where: {
          conversation_id: params.conversationId,
          marker_code: marker.code,
        },
        select: { id: true },
      });
      if (existing) return;
    }

    await this.prisma.business_events.create({
      data: {
        company_id: params.companyId,
        client_id: params.clientId,
        conversation_id: params.conversationId || null,
        end_user_id: params.endUserId || null,
        marker_code: marker.code,
        values: values as any,
        origin_channel: params.originChannel || null,
      },
    });
    this.logger.log(
      `📊 Marcador de negócio registrado: ${marker.code} (conversa ${params.conversationId})`,
    );
  }

  // ── Agregação analítica ─────────────────────────────────────────

  async getBusinessAnalytics(
    companyId: string,
    opts: {
      from?: Date;
      to?: Date;
      clientId?: string;
      channel?: string;
    } = {},
  ) {
    const where: Record<string, unknown> = { company_id: companyId };
    if (opts.clientId) where.client_id = opts.clientId;
    if (opts.channel) where.origin_channel = opts.channel;
    if (opts.from || opts.to) {
      where.created_at = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    const [events, config] = await Promise.all([
      this.prisma.business_events.findMany({
        where: where as any,
        orderBy: { created_at: 'desc' },
        take: 20000,
        include: {
          end_users: { select: { name: true } },
          conversations: { select: { origin_channel: true } },
        },
      }),
      opts.clientId ? this.getConfig(opts.clientId) : Promise.resolve(null),
    ]);

    const labels = new Map<string, string>();
    const sumFields = new Map<string, Set<string>>();
    for (const marker of config?.markers ?? []) {
      labels.set(marker.code, marker.label || marker.code);
      sumFields.set(marker.code, new Set(marker.capture || []));
    }

    const totals = new Map<string, MarkerTotal>();
    const daily = new Map<
      string,
      { date: string; counts: Record<string, number> }
    >();

    for (const event of events) {
      const total =
        totals.get(event.marker_code) ||
        ({
          code: event.marker_code,
          label: labels.get(event.marker_code) || event.marker_code,
          count: 0,
          sums: {},
          lastAt: null,
        } satisfies MarkerTotal);

      total.count += 1;
      const values = (event.values as Record<string, unknown>) || {};
      for (const key of sumFields.get(event.marker_code) || []) {
        const num = Number(values[key]);
        if (Number.isFinite(num)) {
          total.sums[key] = (total.sums[key] || 0) + num;
        }
      }
      const createdAt = event.created_at
        ? new Date(event.created_at).toISOString()
        : null;
      if (createdAt && (!total.lastAt || createdAt > total.lastAt)) {
        total.lastAt = createdAt;
      }
      totals.set(event.marker_code, total);

      if (createdAt) {
        const day = createdAt.slice(0, 10);
        const dayEntry = daily.get(day) || {
          date: day,
          counts: {} as Record<string, number>,
        };
        dayEntry.counts[event.marker_code] =
          (dayEntry.counts[event.marker_code] || 0) + 1;
        daily.set(day, dayEntry);
      }
    }

    // Funil na ordem configurada do cliente (quando client_id informado)
    let funnel: Array<{
      code: string;
      label: string;
      count: number;
      conversionFromPrevious: number | null;
    }> | null = null;
    if (config && config.funnel.length) {
      funnel = config.funnel.map((code, index) => {
        const total = totals.get(code);
        const count = total?.count || 0;
        let conversionFromPrevious: number | null = null;
        if (index > 0) {
          const previousCount =
            totals.get(config.funnel[index - 1])?.count || 0;
          conversionFromPrevious =
            previousCount > 0
              ? Math.round((count / previousCount) * 100)
              : null;
        }
        return {
          code,
          label: labels.get(code) || code,
          count,
          conversionFromPrevious,
        };
      });
    }

    const detailedEvents = events.slice(0, 200).map((event) => ({
      id: event.id,
      markerCode: event.marker_code,
      markerLabel: labels.get(event.marker_code) || event.marker_code,
      conversationId: event.conversation_id,
      endUserName: event.end_users?.name || null,
      channel: event.conversations?.origin_channel || event.origin_channel,
      values: (event.values as Record<string, unknown>) || {},
      createdAt: event.created_at
        ? new Date(event.created_at).toISOString()
        : null,
    }));

    return {
      period: {
        from: opts.from?.toISOString() || null,
        to: opts.to?.toISOString() || null,
      },
      totals: [...totals.values()],
      funnel,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      events: detailedEvents,
    };
  }

  // ── BI Dashboard & Funil Consolidado ────────────────────────────

  async getBiDashboard(
    companyId: string,
    opts: {
      clientId?: string;
      channel?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    const where: Record<string, unknown> = { company_id: companyId };
    if (opts.clientId) where.client_id = opts.clientId;
    if (opts.channel) where.channel = opts.channel;
    if (opts.from || opts.to) {
      where.created_at = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    // Busca todas as interações do período selecionado
    const interactions = await this.prisma.painel_interactions.findMany({
      where: where as any,
      select: {
        id: true,
        channel: true,
        agent_name: true,
        has_human_answer: true,
        is_right_party: true,
        is_debt_presented: true,
        is_agreement_reached: true,
        is_promise_to_pay: true,
        debt_amount: true,
        agreement_amount: true,
        promise_amount: true,
        duration_seconds: true,
        barge_in_count: true,
        total_tokens: true,
        estimated_cost_usd: true,
        status: true,
        disposition: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    });

    let totalInteractions = interactions.length;
    let humanAnswers = 0;
    let rightParties = 0; // CPC
    let debtsPresented = 0; // CPCA
    let agreementsReached = 0;
    let promisesToPay = 0;
    let totalAgreementAmount = 0;
    let totalPromiseAmount = 0;
    let totalDebtAmount = 0;
    let totalDurationSec = 0;
    let totalBargeIns = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;

    // Agrupadores
    const dailyMap = new Map<
      string,
      {
        date: string;
        total: number;
        human_answers: number;
        cpc: number;
        cpca: number;
        agreements: number;
        promises: number;
        agreement_value: number;
      }
    >();

    const hourlyMap = new Map<
      number,
      {
        hour: number;
        hourLabel: string;
        total: number;
        human_answers: number;
        cpc: number;
        cpca: number;
        agreements: number;
      }
    >();

    // Inicializa as 24 horas do dia
    for (let h = 0; h < 24; h++) {
      const label = `${String(h).padStart(2, '0')}:00`;
      hourlyMap.set(h, {
        hour: h,
        hourLabel: label,
        total: 0,
        human_answers: 0,
        cpc: 0,
        cpca: 0,
        agreements: 0,
      });
    }

    const monthlyMap = new Map<
      string,
      {
        month: string;
        total: number;
        cpc: number;
        agreements: number;
        agreement_value: number;
      }
    >();

    const channelMap = new Map<
      string,
      { channel: string; total: number; agreements: number }
    >();
    const agentMap = new Map<
      string,
      { agent: string; total: number; agreements: number }
    >();

    for (const item of interactions) {
      if (item.has_human_answer) humanAnswers++;
      if (item.is_right_party) rightParties++;
      if (item.is_debt_presented) debtsPresented++;
      if (item.is_agreement_reached) agreementsReached++;
      if (item.is_promise_to_pay) promisesToPay++;

      const agAmount = item.agreement_amount
        ? Number(item.agreement_amount)
        : 0;
      const prAmount = item.promise_amount ? Number(item.promise_amount) : 0;
      const dbAmount = item.debt_amount ? Number(item.debt_amount) : 0;

      totalAgreementAmount += agAmount;
      totalPromiseAmount += prAmount;
      totalDebtAmount += dbAmount;
      totalDurationSec += item.duration_seconds || 0;
      totalBargeIns += item.barge_in_count || 0;
      totalTokens += item.total_tokens || 0;
      totalCostUsd += item.estimated_cost_usd
        ? Number(item.estimated_cost_usd)
        : 0;

      const dateObj = new Date(item.created_at);
      const dayKey = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD
      const hourKey = dateObj.getHours(); // 0 - 23
      const monthKey = dateObj.toISOString().slice(0, 7); // YYYY-MM

      // Agrupamento Diário
      const dayEntry = dailyMap.get(dayKey) || {
        date: dayKey,
        total: 0,
        human_answers: 0,
        cpc: 0,
        cpca: 0,
        agreements: 0,
        promises: 0,
        agreement_value: 0,
      };
      dayEntry.total++;
      if (item.has_human_answer) dayEntry.human_answers++;
      if (item.is_right_party) dayEntry.cpc++;
      if (item.is_debt_presented) dayEntry.cpca++;
      if (item.is_agreement_reached) {
        dayEntry.agreements++;
        dayEntry.agreement_value += agAmount;
      }
      if (item.is_promise_to_pay) dayEntry.promises++;
      dailyMap.set(dayKey, dayEntry);

      // Agrupamento Horário
      const hourEntry = hourlyMap.get(hourKey)!;
      hourEntry.total++;
      if (item.has_human_answer) hourEntry.human_answers++;
      if (item.is_right_party) hourEntry.cpc++;
      if (item.is_debt_presented) hourEntry.cpca++;
      if (item.is_agreement_reached) hourEntry.agreements++;

      // Agrupamento Mensal
      const monthEntry = monthlyMap.get(monthKey) || {
        month: monthKey,
        total: 0,
        cpc: 0,
        agreements: 0,
        agreement_value: 0,
      };
      monthEntry.total++;
      if (item.is_right_party) monthEntry.cpc++;
      if (item.is_agreement_reached) {
        monthEntry.agreements++;
        monthEntry.agreement_value += agAmount;
      }
      monthlyMap.set(monthKey, monthEntry);

      // Agrupamento Canal
      const ch = item.channel || 'webchat';
      const chEntry = channelMap.get(ch) || {
        channel: ch,
        total: 0,
        agreements: 0,
      };
      chEntry.total++;
      if (item.is_agreement_reached) chEntry.agreements++;
      channelMap.set(ch, chEntry);

      // Agrupamento Agente
      const ag = item.agent_name || 'Agente Padrão';
      const agEntry = agentMap.get(ag) || {
        agent: ag,
        total: 0,
        agreements: 0,
      };
      agEntry.total++;
      if (item.is_agreement_reached) agEntry.agreements++;
      agentMap.set(ag, agEntry);
    }

    const cpcRate = humanAnswers > 0 ? (rightParties / humanAnswers) * 100 : 0;
    const cpcaRate =
      rightParties > 0 ? (debtsPresented / rightParties) * 100 : 0;
    const agreementRate =
      rightParties > 0 ? (agreementsReached / rightParties) * 100 : 0;
    const promiseRate =
      rightParties > 0 ? (promisesToPay / rightParties) * 100 : 0;

    // Funil visual estruturado
    const funnelSteps = [
      {
        step: 'total',
        label: 'Total de Contatos',
        count: totalInteractions,
        pct_of_total: 100,
        conversion_from_prev: 100,
      },
      {
        step: 'human_answer',
        label: 'Alô (Atendimento Humano)',
        count: humanAnswers,
        pct_of_total:
          totalInteractions > 0
            ? Number(((humanAnswers / totalInteractions) * 100).toFixed(1))
            : 0,
        conversion_from_prev:
          totalInteractions > 0
            ? Number(((humanAnswers / totalInteractions) * 100).toFixed(1))
            : 0,
      },
      {
        step: 'cpc',
        label: 'CPC (Pessoa Certa Confirmada)',
        count: rightParties,
        pct_of_total:
          totalInteractions > 0
            ? Number(((rightParties / totalInteractions) * 100).toFixed(1))
            : 0,
        conversion_from_prev:
          humanAnswers > 0
            ? Number(((rightParties / humanAnswers) * 100).toFixed(1))
            : 0,
      },
      {
        step: 'cpca',
        label: 'CPCA (Apresentação da Dívida)',
        count: debtsPresented,
        pct_of_total:
          totalInteractions > 0
            ? Number(((debtsPresented / totalInteractions) * 100).toFixed(1))
            : 0,
        conversion_from_prev:
          rightParties > 0
            ? Number(((debtsPresented / rightParties) * 100).toFixed(1))
            : 0,
      },
      {
        step: 'agreement',
        label: 'Acordo Fechado',
        count: agreementsReached,
        pct_of_total:
          totalInteractions > 0
            ? Number(((agreementsReached / totalInteractions) * 100).toFixed(1))
            : 0,
        conversion_from_prev:
          debtsPresented > 0
            ? Number(((agreementsReached / debtsPresented) * 100).toFixed(1))
            : 0,
      },
      {
        step: 'promise',
        label: 'Promessa de Pagamento (PTP)',
        count: promisesToPay,
        pct_of_total:
          totalInteractions > 0
            ? Number(((promisesToPay / totalInteractions) * 100).toFixed(1))
            : 0,
        conversion_from_prev:
          debtsPresented > 0
            ? Number(((promisesToPay / debtsPresented) * 100).toFixed(1))
            : 0,
      },
    ];

    return {
      kpis: {
        total_interactions: totalInteractions,
        human_answers: humanAnswers,
        cpc: rightParties,
        cpca: debtsPresented,
        agreements: agreementsReached,
        promises: promisesToPay,
        total_agreement_value: totalAgreementAmount,
        total_promise_value: totalPromiseAmount,
        total_debt_value: totalDebtAmount,
        cpc_rate_pct: Number(cpcRate.toFixed(1)),
        cpca_rate_pct: Number(cpcaRate.toFixed(1)),
        agreement_conversion_pct: Number(agreementRate.toFixed(1)),
        promise_rate_pct: Number(promiseRate.toFixed(1)),
        avg_duration_sec:
          totalInteractions > 0
            ? Math.round(totalDurationSec / totalInteractions)
            : 0,
        total_barge_ins: totalBargeIns,
        total_tokens: totalTokens,
        total_cost_usd: Number(totalCostUsd.toFixed(4)),
        total_cost_brl: Number((totalCostUsd * 5.5).toFixed(2)),
      },
      funnel: funnelSteps,
      by_day: [...dailyMap.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      by_hour: [...hourlyMap.values()].sort((a, b) => a.hour - b.hour),
      by_month: [...monthlyMap.values()].sort((a, b) =>
        a.month.localeCompare(b.month),
      ),
      by_channel: [...channelMap.values()].sort((a, b) => b.total - a.total),
      by_agent: [...agentMap.values()].sort((a, b) => b.total - a.total),
    };
  }

  // ── Relatório Detalhado de Interações ───────────────────────────

  async getInteractionsReport(
    companyId: string,
    opts: {
      clientId?: string;
      channel?: string;
      status?: string;
      disposition?: string;
      search?: string;
      from?: Date;
      to?: Date;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 25));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { company_id: companyId };
    if (opts.clientId) where.client_id = opts.clientId;
    if (opts.channel) where.channel = opts.channel;
    if (opts.status) where.status = opts.status;
    if (opts.disposition) where.disposition = opts.disposition;
    if (opts.from || opts.to) {
      where.created_at = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    if (opts.search) {
      where.OR = [
        { client_identifier: { contains: opts.search, mode: 'insensitive' } },
        { client_name: { contains: opts.search, mode: 'insensitive' } },
        { agreement_id: { contains: opts.search, mode: 'insensitive' } },
        { session_id: { contains: opts.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.painel_interactions.findMany({
        where: where as any,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.painel_interactions.count({ where: where as any }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ── Relatório de Consumo e Custos ───────────────────────────────

  async getCostsAndConsumption(
    companyId: string,
    opts: {
      clientId?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    const where: Record<string, unknown> = { company_id: companyId };
    if (opts.clientId) where.client_id = opts.clientId;
    if (opts.from || opts.to) {
      where.created_at = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    const [interactions, agentRuns] = await Promise.all([
      this.prisma.painel_interactions.findMany({
        where: where as any,
        select: {
          channel: true,
          duration_seconds: true,
          barge_in_count: true,
          total_tokens: true,
          prompt_tokens: true,
          completion_tokens: true,
          estimated_cost_usd: true,
          llm_provider: true,
          llm_model: true,
          created_at: true,
        },
      }),
      this.prisma.agent_runs.findMany({
        where: {
          company_id: companyId,
          ...(opts.from || opts.to
            ? {
                started_at: {
                  ...(opts.from ? { gte: opts.from } : {}),
                  ...(opts.to ? { lte: opts.to } : {}),
                },
              }
            : {}),
        },
        select: {
          provider: true,
          model: true,
          input_tokens: true,
          output_tokens: true,
          total_tokens: true,
          cost: true,
          latency_ms: true,
          status: true,
          started_at: true,
        },
      }),
    ]);

    // Agrupamento por Modelo
    const byModel = new Map<
      string,
      {
        model: string;
        provider: string;
        total_runs: number;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        cost_usd: number;
        avg_latency_ms: number;
      }
    >();

    // Agrupamento por Provedor
    const byProvider = new Map<
      string,
      {
        provider: string;
        runs: number;
        tokens: number;
        cost_usd: number;
      }
    >();

    let totalRuns = agentRuns.length || interactions.length;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;
    let totalVoiceDurationSec = 0;
    let totalBargeIns = 0;
    const latencies: number[] = [];

    // Processa runs de LLM
    for (const run of agentRuns) {
      const model = run.model || 'desconhecido';
      const provider = run.provider || 'desconhecido';
      const inTok = run.input_tokens || 0;
      const outTok = run.output_tokens || 0;
      const totTok = run.total_tokens || inTok + outTok;
      const cost = run.cost ? Number(run.cost) : 0;
      const lat = run.latency_ms || 0;

      totalTokens += totTok;
      inputTokens += inTok;
      outputTokens += outTok;
      totalCostUsd += cost;
      if (lat > 0) latencies.push(lat);

      // By Model
      const mEntry = byModel.get(model) || {
        model,
        provider,
        total_runs: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        avg_latency_ms: 0,
      };
      mEntry.total_runs++;
      mEntry.input_tokens += inTok;
      mEntry.output_tokens += outTok;
      mEntry.total_tokens += totTok;
      mEntry.cost_usd += cost;
      byModel.set(model, mEntry);

      // By Provider
      const pEntry = byProvider.get(provider) || {
        provider,
        runs: 0,
        tokens: 0,
        cost_usd: 0,
      };
      pEntry.runs++;
      pEntry.tokens += totTok;
      pEntry.cost_usd += cost;
      byProvider.set(provider, pEntry);
    }

    // Processa interações de voz
    for (const int of interactions) {
      if (int.channel?.includes('voice')) {
        totalVoiceDurationSec += int.duration_seconds || 0;
        totalBargeIns += int.barge_in_count || 0;
      }
      if (agentRuns.length === 0) {
        // Fallback caso não haja agent_runs salvos
        totalTokens += int.total_tokens || 0;
        inputTokens += int.prompt_tokens || 0;
        outputTokens += int.completion_tokens || 0;
        totalCostUsd += int.estimated_cost_usd
          ? Number(int.estimated_cost_usd)
          : 0;
      }
    }

    // Cálculo de P95 Latency
    latencies.sort((a, b) => a - b);
    const p95LatencyMs =
      latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    return {
      totals: {
        total_runs: totalRuns,
        total_tokens: totalTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_cost_usd: Number(totalCostUsd.toFixed(4)),
        total_cost_brl: Number((totalCostUsd * 5.5).toFixed(2)),
        voice_duration_minutes: Math.round(totalVoiceDurationSec / 60),
        total_barge_ins: totalBargeIns,
        p95_latency_ms: p95LatencyMs,
      },
      by_model: [...byModel.values()].sort(
        (a, b) => b.total_tokens - a.total_tokens,
      ),
      by_provider: [...byProvider.values()].sort(
        (a, b) => b.cost_usd - a.cost_usd,
      ),
    };
  }
}
