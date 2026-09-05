import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { UUID_SHAPE_REGEX } from '../common/validators/uuid-shape';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  ActivationConditionGroup,
} from '../orchestrator/utils/condition-evaluator.util';
import type {
  AnalyticsConfigPayload,
  BusinessMarkerDto,
  SessionFieldMetricDto,
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
/** TTL do cache do BI dashboard (invalidação implícita por TTL curto) */
const BI_DASHBOARD_CACHE_TTL_S = 45;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

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
      metrics: [],
      markers: [],
      funnel: [],
    };

    const normalized: AnalyticsConfigPayload = {
      metrics: Array.isArray(config.metrics) ? config.metrics : [],
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
      metrics: config.metrics ?? [],
      markers: config.markers ?? [],
      funnel: config.funnel ?? [],
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
   * Avalia os marcadores e métricas do cliente sobre o estado pós-tool da conversa.
   * Nunca lança — falhas são logadas e ignoradas para não afetar o atendimento.
   */
  async evaluateAndRecord(params: EvaluateParams): Promise<void> {
    try {
      const config = await this.getConfig(params.clientId);
      const markers = config.markers || [];
      const metrics = config.metrics || [];
      if (!markers.length && !metrics.length) return;

      const promises: Promise<void>[] = [];

      for (const metric of metrics) {
        promises.push(
          this.evaluateSessionMetric(metric, params).catch((err) => {
            this.logger.warn(
              `Erro ao avaliar métrica de sessão "${metric.field}": ${(err as Error).message}`,
            );
          }),
        );
      }

      for (const marker of markers) {
        promises.push(
          this.evaluateMarker(marker, params).catch((err) => {
            this.logger.warn(
              `Erro ao avaliar marcador "${marker.code}": ${(err as Error).message}`,
            );
          }),
        );
      }

      await Promise.all(promises);
    } catch (err) {
      this.logger.warn(
        `Analytics: falha ao carregar configuração: ${(err as Error).message}`,
      );
    }
  }

  private async evaluateSessionMetric(
    metric: SessionFieldMetricDto,
    params: EvaluateParams,
  ) {
    const rawVal = params.state[metric.field];
    if (rawVal === undefined || rawVal === null) return;

    let matched = false;
    if (metric.expected_value !== undefined && metric.expected_value !== '') {
      matched =
        String(rawVal).trim().toLowerCase() ===
        String(metric.expected_value).trim().toLowerCase();
    } else if (typeof rawVal === 'boolean') {
      matched = rawVal;
    } else if (typeof rawVal === 'number') {
      matched = rawVal > 0;
    } else if (typeof rawVal === 'string') {
      const s = rawVal.trim().toLowerCase();
      matched =
        s !== '' &&
        s !== 'false' &&
        s !== '0' &&
        s !== 'null' &&
        s !== 'undefined';
    }

    if (!matched) return;

    const code = metric.field;
    const values: Record<string, unknown> = {
      [metric.field]: rawVal,
    };

    const data = {
      company_id: params.companyId,
      client_id: params.clientId,
      conversation_id: params.conversationId || null,
      end_user_id: params.endUserId || null,
      marker_code: code,
      values: values as any,
      origin_channel: params.originChannel || null,
    };

    if (params.conversationId) {
      await this.prisma.business_events.upsert({
        where: {
          conversation_id_marker_code: {
            conversation_id: params.conversationId,
            marker_code: code,
          },
        },
        update: {
          values: values as any,
        },
        create: data,
      });
    } else {
      await this.prisma.business_events.create({ data });
    }

    this.logger.log(
      `📊 Métrica de sessão registrada: ${metric.field}=${rawVal} (conversa ${params.conversationId})`,
    );
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

    // Upsert idempotente: um evento por conversa/marcador (unique constraint)
    const data = {
      company_id: params.companyId,
      client_id: params.clientId,
      conversation_id: params.conversationId || null,
      end_user_id: params.endUserId || null,
      marker_code: marker.code,
      values: values as any,
      origin_channel: params.originChannel || null,
    };

    if (params.conversationId) {
      await this.prisma.business_events.upsert({
        where: {
          conversation_id_marker_code: {
            conversation_id: params.conversationId,
            marker_code: marker.code,
          },
        },
        update: {},
        create: data,
      });
    } else {
      await this.prisma.business_events.create({ data });
    }
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
    for (const metric of config?.metrics ?? []) {
      labels.set(metric.field, metric.label || metric.field);
      if (metric.aggregate === 'sum') {
        sumFields.set(metric.field, new Set([metric.field]));
      }
    }
    for (const marker of config?.markers ?? []) {
      if (!labels.has(marker.code)) {
        labels.set(marker.code, marker.label || marker.code);
      }
      if (!sumFields.has(marker.code)) {
        sumFields.set(marker.code, new Set(marker.capture || []));
      }
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

  /** Fuso horário do servidor, usado para reproduzir o agrupamento horário
   *  anteriormente feito com Date#getHours() em JavaScript. */
  private readonly serverTimeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  private buildInteractionWhere(
    companyId: string,
    opts: {
      clientId?: string;
      channel?: string;
      status?: string;
      disposition?: string;
      from?: Date;
      to?: Date;
    },
  ): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`company_id = ${companyId}::uuid`,
    ];
    if (opts.clientId)
      conditions.push(Prisma.sql`client_id = ${opts.clientId}::uuid`);
    if (opts.channel) conditions.push(Prisma.sql`channel = ${opts.channel}`);
    if (opts.status) conditions.push(Prisma.sql`status = ${opts.status}`);
    if (opts.disposition)
      conditions.push(Prisma.sql`disposition = ${opts.disposition}`);
    if (opts.from) conditions.push(Prisma.sql`created_at >= ${opts.from}`);
    if (opts.to) conditions.push(Prisma.sql`created_at <= ${opts.to}`);
    return Prisma.join(conditions, ' AND ');
  }

  async getBiDashboard(
    companyId: string,
    opts: {
      clientId?: string;
      channel?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    const cacheKey = `bi:dashboard:${companyId}:${opts.clientId ?? 'all'}:${
      opts.from?.toISOString() ?? 'none'
    }:${opts.to?.toISOString() ?? 'none'}`;
    const cached =
      await this.redisService.get<
        Awaited<ReturnType<AnalyticsService['buildBiDashboard']>>
      >(cacheKey);
    if (cached) return cached;

    const result = await this.buildBiDashboard(companyId, opts);
    await this.redisService.set(cacheKey, result, BI_DASHBOARD_CACHE_TTL_S);
    return result;
  }

  private async buildBiDashboard(
    companyId: string,
    opts: {
      clientId?: string;
      channel?: string;
      from?: Date;
      to?: Date;
    },
  ) {
    const where = this.buildInteractionWhere(companyId, opts);

    const rows = await this.prisma.$queryRaw<
      Array<{
        kind: 'kpi' | 'day' | 'hour' | 'month' | 'channel' | 'agent';
        day: string | null;
        hour: number | null;
        month: string | null;
        channel: string | null;
        agent: string | null;
        total: number;
        human_answers: number;
        cpc: number;
        cpca: number;
        agreements: number;
        promises: number;
        agreement_value: number;
        promise_value: number;
        debt_value: number;
        total_duration: number;
        barge_ins: number;
        total_tokens: number;
        cost_usd: number;
      }>
    >(Prisma.sql`
        WITH base AS (
          SELECT * FROM painel_interactions WHERE ${where}
        )
        SELECT
          'kpi' AS kind,
          NULL::text AS day,
          NULL::int AS hour,
          NULL::text AS month,
          NULL::text AS channel,
          NULL::text AS agent,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE has_human_answer)::int AS human_answers,
          COUNT(*) FILTER (WHERE is_right_party)::int AS cpc,
          COUNT(*) FILTER (WHERE is_debt_presented)::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          COUNT(*) FILTER (WHERE is_promise_to_pay)::int AS promises,
          COALESCE(SUM(agreement_amount), 0)::float8 AS agreement_value,
          COALESCE(SUM(promise_amount), 0)::float8 AS promise_value,
          COALESCE(SUM(debt_amount), 0)::float8 AS debt_value,
          COALESCE(SUM(duration_seconds), 0)::int AS total_duration,
          COALESCE(SUM(barge_in_count), 0)::int AS barge_ins,
          COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
          COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost_usd
        FROM base
        UNION ALL
        SELECT
          'day' AS kind,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          NULL::int AS hour,
          NULL::text AS month,
          NULL::text AS channel,
          NULL::text AS agent,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE has_human_answer)::int AS human_answers,
          COUNT(*) FILTER (WHERE is_right_party)::int AS cpc,
          COUNT(*) FILTER (WHERE is_debt_presented)::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          COUNT(*) FILTER (WHERE is_promise_to_pay)::int AS promises,
          COALESCE(SUM(agreement_amount) FILTER (WHERE is_agreement_reached), 0)::float8 AS agreement_value,
          NULL::float8 AS promise_value,
          NULL::float8 AS debt_value,
          NULL::int AS total_duration,
          NULL::int AS barge_ins,
          NULL::int AS total_tokens,
          NULL::float8 AS cost_usd
        FROM base
        GROUP BY 2
        UNION ALL
        SELECT
          'hour' AS kind,
          NULL::text AS day,
          EXTRACT(HOUR FROM created_at AT TIME ZONE ${this.serverTimeZone})::int AS hour,
          NULL::text AS month,
          NULL::text AS channel,
          NULL::text AS agent,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE has_human_answer)::int AS human_answers,
          COUNT(*) FILTER (WHERE is_right_party)::int AS cpc,
          COUNT(*) FILTER (WHERE is_debt_presented)::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          NULL::int AS promises,
          NULL::float8 AS agreement_value,
          NULL::float8 AS promise_value,
          NULL::float8 AS debt_value,
          NULL::int AS total_duration,
          NULL::int AS barge_ins,
          NULL::int AS total_tokens,
          NULL::float8 AS cost_usd
        FROM base
        GROUP BY 3
        UNION ALL
        SELECT
          'month' AS kind,
          NULL::text AS day,
          NULL::int AS hour,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
          NULL::text AS channel,
          NULL::text AS agent,
          COUNT(*)::int AS total,
          NULL::int AS human_answers,
          COUNT(*) FILTER (WHERE is_right_party)::int AS cpc,
          NULL::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          NULL::int AS promises,
          COALESCE(SUM(agreement_amount) FILTER (WHERE is_agreement_reached), 0)::float8 AS agreement_value,
          NULL::float8 AS promise_value,
          NULL::float8 AS debt_value,
          NULL::int AS total_duration,
          NULL::int AS barge_ins,
          NULL::int AS total_tokens,
          NULL::float8 AS cost_usd
        FROM base
        GROUP BY 4
        UNION ALL
        SELECT
          'channel' AS kind,
          NULL::text AS day,
          NULL::int AS hour,
          NULL::text AS month,
          COALESCE(channel, 'webchat') AS channel,
          NULL::text AS agent,
          COUNT(*)::int AS total,
          NULL::int AS human_answers,
          NULL::int AS cpc,
          NULL::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          NULL::int AS promises,
          NULL::float8 AS agreement_value,
          NULL::float8 AS promise_value,
          NULL::float8 AS debt_value,
          NULL::int AS total_duration,
          NULL::int AS barge_ins,
          NULL::int AS total_tokens,
          NULL::float8 AS cost_usd
        FROM base
        GROUP BY 5
        UNION ALL
        SELECT
          'agent' AS kind,
          NULL::text AS day,
          NULL::int AS hour,
          NULL::text AS month,
          NULL::text AS channel,
          COALESCE(agent_name, 'Agente Padrão') AS agent,
          COUNT(*)::int AS total,
          NULL::int AS human_answers,
          NULL::int AS cpc,
          NULL::int AS cpca,
          COUNT(*) FILTER (WHERE is_agreement_reached)::int AS agreements,
          NULL::int AS promises,
          NULL::float8 AS agreement_value,
          NULL::float8 AS promise_value,
          NULL::float8 AS debt_value,
          NULL::int AS total_duration,
          NULL::int AS barge_ins,
          NULL::int AS total_tokens,
          NULL::float8 AS cost_usd
        FROM base
        GROUP BY 6
      `);

    const kpiRows = rows.filter((r) => r.kind === 'kpi');
    const dailyRows: Array<{
      date: string;
      total: number;
      human_answers: number;
      cpc: number;
      cpca: number;
      agreements: number;
      promises: number;
      agreement_value: number;
    }> = [];
    const hourlyRows: Array<{
      hour: number;
      total: number;
      human_answers: number;
      cpc: number;
      cpca: number;
      agreements: number;
    }> = [];
    const monthlyRows: Array<{
      month: string;
      total: number;
      cpc: number;
      agreements: number;
      agreement_value: number;
    }> = [];
    const channelRows: Array<{
      channel: string;
      total: number;
      agreements: number;
    }> = [];
    const agentRows: Array<{
      agent: string;
      total: number;
      agreements: number;
    }> = [];

    for (const row of rows) {
      if (row.kind === 'day') {
        dailyRows.push({
          date: row.day || '',
          total: row.total,
          human_answers: row.human_answers,
          cpc: row.cpc,
          cpca: row.cpca,
          agreements: row.agreements,
          promises: row.promises,
          agreement_value: row.agreement_value,
        });
      } else if (row.kind === 'hour') {
        hourlyRows.push({
          hour: row.hour || 0,
          total: row.total,
          human_answers: row.human_answers,
          cpc: row.cpc,
          cpca: row.cpca,
          agreements: row.agreements,
        });
      } else if (row.kind === 'month') {
        monthlyRows.push({
          month: row.month || '',
          total: row.total,
          cpc: row.cpc,
          agreements: row.agreements,
          agreement_value: row.agreement_value,
        });
      } else if (row.kind === 'channel') {
        channelRows.push({
          channel: row.channel || 'webchat',
          total: row.total,
          agreements: row.agreements,
        });
      } else if (row.kind === 'agent') {
        agentRows.push({
          agent: row.agent || 'Agente Padrão',
          total: row.total,
          agreements: row.agreements,
        });
      }
    }

    const kpi = kpiRows[0] ?? {
      total: 0,
      human_answers: 0,
      cpc: 0,
      cpca: 0,
      agreements: 0,
      promises: 0,
      agreement_value: 0,
      promise_value: 0,
      debt_value: 0,
      total_duration: 0,
      barge_ins: 0,
      total_tokens: 0,
      cost_usd: 0,
    };

    const totalInteractions = kpi.total;
    const humanAnswers = kpi.human_answers;
    const rightParties = kpi.cpc;
    const debtsPresented = kpi.cpca;
    const agreementsReached = kpi.agreements;
    const promisesToPay = kpi.promises;

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

    // Garante as 24 horas do dia (paridade com a implementação anterior)
    const hourMap = new Map(hourlyRows.map((r) => [r.hour, r]));
    const byHour: Array<{
      hour: number;
      hourLabel: string;
      total: number;
      human_answers: number;
      cpc: number;
      cpca: number;
      agreements: number;
    }> = [];
    for (let h = 0; h < 24; h++) {
      const row = hourMap.get(h);
      byHour.push({
        hour: h,
        hourLabel: `${String(h).padStart(2, '0')}:00`,
        total: row?.total ?? 0,
        human_answers: row?.human_answers ?? 0,
        cpc: row?.cpc ?? 0,
        cpca: row?.cpca ?? 0,
        agreements: row?.agreements ?? 0,
      });
    }

    return {
      kpis: {
        total_interactions: totalInteractions,
        human_answers: humanAnswers,
        cpc: rightParties,
        cpca: debtsPresented,
        agreements: agreementsReached,
        promises: promisesToPay,
        total_agreement_value: kpi.agreement_value,
        total_promise_value: kpi.promise_value,
        total_debt_value: kpi.debt_value,
        cpc_rate_pct: Number(cpcRate.toFixed(1)),
        cpca_rate_pct: Number(cpcaRate.toFixed(1)),
        agreement_conversion_pct: Number(agreementRate.toFixed(1)),
        promise_rate_pct: Number(promiseRate.toFixed(1)),
        avg_duration_sec:
          totalInteractions > 0
            ? Math.round(kpi.total_duration / totalInteractions)
            : 0,
        total_barge_ins: kpi.barge_ins,
        total_tokens: kpi.total_tokens,
        total_cost_usd: Number(kpi.cost_usd.toFixed(4)),
        total_cost_brl: Number((kpi.cost_usd * 5.5).toFixed(2)),
      },
      funnel: funnelSteps,
      by_day: [...dailyRows].sort((a, b) => a.date.localeCompare(b.date)),
      by_hour: byHour.sort((a, b) => a.hour - b.hour),
      by_month: [...monthlyRows].sort((a, b) => a.month.localeCompare(b.month)),
      by_channel: [...channelRows].sort((a, b) => b.total - a.total),
      by_agent: [...agentRows].sort((a, b) => b.total - a.total),
    };
  }

  // ── Relatório Detalhado de Interações ───────────────────────────

  /** Campos escalares listados no relatório (exclui o JSONB pesado de messages). */
  private readonly interactionListArgs =
    Prisma.validator<Prisma.painel_interactionsDefaultArgs>()({
      select: {
        id: true,
        company_id: true,
        client_id: true,
        agent_id: true,
        session_id: true,
        channel: true,
        direction: true,
        interaction_mode: true,
        client_identifier: true,
        company_identifier: true,
        client_name: true,
        agent_name: true,
        has_human_answer: true,
        human_answered_at: true,
        is_right_party: true,
        right_party_at: true,
        is_debt_presented: true,
        debt_presented_at: true,
        debt_amount: true,
        is_agreement_reached: true,
        agreement_at: true,
        agreement_id: true,
        agreement_amount: true,
        payment_method: true,
        is_promise_to_pay: true,
        promise_to_pay_at: true,
        promise_due_date: true,
        promise_amount: true,
        disposition: true,
        service_step: true,
        tagcode: true,
        status: true,
        barge_in_count: true,
        avg_barge_in_latency_ms: true,
        avg_first_byte_latency_ms: true,
        is_answering_machine: true,
        call_id: true,
        call_status: true,
        recording_url: true,
        duration_seconds: true,
        billable_seconds: true,
        hangup_cause: true,
        llm_provider: true,
        llm_model: true,
        total_tokens: true,
        prompt_tokens: true,
        completion_tokens: true,
        estimated_cost_usd: true,
        avg_latency_ms: true,
        sentiment: true,
        summary: true,
        context_variables: true,
        created_at: true,
        updated_at: true,
        started_at: true,
        ended_at: true,
      },
    });

  /** Deriva de messages (no banco) os campos exibidos na listagem, evitando
   *  transportar o JSONB completo de mensagens para a API. */
  private async attachInteractionDerivedFields<
    T extends { id: string; context_variables?: unknown },
  >(
    companyId: string,
    items: T[],
    includeHeavy = false,
  ): Promise<
    (T & {
      messages_count: number;
      first_user_message: string | null;
      last_user_message: string | null;
      last_assistant_message: string | null;
      full_transcript?: string | null;
      executed_tools?: string[];
    })[]
  > {
    const ids = items
      .map((i) => i.id)
      .filter((id) => UUID_SHAPE_REGEX.test(id));
    if (ids.length === 0) {
      return items.map((it) => ({
        ...it,
        messages_count: 0,
        first_user_message: null,
        last_user_message: null,
        last_assistant_message: null,
        ...(includeHeavy
          ? { full_transcript: null, executed_tools: [] as string[] }
          : {}),
      }));
    }

    const heavySelect = includeHeavy
      ? Prisma.sql`
          ,
          (SELECT string_agg(
              CASE WHEN m->>'role' = 'user' THEN '[Cliente]: ' ELSE '[IA]: ' END || (m->>'content'),
              ' | ' ORDER BY ord)
            FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, ord)) AS full_transcript,
          (SELECT COALESCE(jsonb_agg(DISTINCT name), '[]'::jsonb) FROM (
              SELECT m->'metadata'->>'tool_name' AS name
                FROM jsonb_array_elements(messages) m
                WHERE m->'metadata'->>'tool_name' IS NOT NULL AND m->'metadata'->>'tool_name' <> ''
              UNION
              SELECT CASE WHEN jsonb_typeof(tc) = 'string' THEN tc#>>'{}' ELSE tc->>'name' END AS name
                FROM jsonb_array_elements(messages) m,
                     jsonb_array_elements(COALESCE(m->'tool_calls', '[]'::jsonb)) tc
                WHERE (jsonb_typeof(tc) = 'string' AND tc#>>'{}' <> '')
                   OR (jsonb_typeof(tc) = 'object' AND tc->>'name' IS NOT NULL AND tc->>'name' <> '')
              UNION
              SELECT tc->'function'->>'name' AS name
                FROM jsonb_array_elements(messages) m,
                     jsonb_array_elements(COALESCE(m->'tool_calls', '[]'::jsonb)) tc
                WHERE tc->'function'->>'name' IS NOT NULL AND tc->'function'->>'name' <> ''
              UNION
              SELECT CASE WHEN jsonb_typeof(m->'function_call') = 'string' THEN m->>'function_call'
                          ELSE m->'function_call'->>'name' END AS name
                FROM jsonb_array_elements(messages) m
                WHERE m->'function_call' IS NOT NULL
                  AND jsonb_typeof(m->'function_call') IN ('string', 'object')
                  AND COALESCE(m->'function_call'->>'name', CASE WHEN jsonb_typeof(m->'function_call') = 'string' THEN m->>'function_call' END, '') <> ''
              UNION
              SELECT m->>'name' AS name
                FROM jsonb_array_elements(messages) m
                WHERE m->>'role' IN ('tool', 'function') AND m->>'name' IS NOT NULL AND m->>'name' <> ''
              UNION
              SELECT m->>'tool_name' AS name
                FROM jsonb_array_elements(messages) m
                WHERE m->>'role' IN ('tool', 'function') AND m->>'tool_name' IS NOT NULL AND m->>'tool_name' <> ''
            ) s WHERE name IS NOT NULL) AS message_tools`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        messages_count: number;
        first_user_message: string | null;
        last_user_message: string | null;
        last_assistant_message: string | null;
        full_transcript?: string | null;
        message_tools?: string[];
      }>
    >(
      Prisma.sql`
        SELECT
          id,
          jsonb_array_length(messages) AS messages_count,
          (SELECT m->>'content' FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, ord)
            WHERE m->>'role' = 'user' ORDER BY ord LIMIT 1) AS first_user_message,
          (SELECT m->>'content' FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, ord)
            WHERE m->>'role' = 'user' ORDER BY ord DESC LIMIT 1) AS last_user_message,
          (SELECT m->>'content' FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, ord)
            WHERE m->>'role' = 'assistant' ORDER BY ord DESC LIMIT 1) AS last_assistant_message${heavySelect}
        FROM painel_interactions
        WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])
      `,
    );

    const derivedById = new Map(rows.map((r) => [r.id, r]));
    return items.map((it) => {
      const derived = derivedById.get(it.id);
      const base = {
        ...it,
        messages_count: derived?.messages_count ?? 0,
        first_user_message: derived?.first_user_message ?? null,
        last_user_message: derived?.last_user_message ?? null,
        last_assistant_message: derived?.last_assistant_message ?? null,
      };
      if (!includeHeavy) return base;
      return {
        ...base,
        full_transcript: derived?.full_transcript ?? null,
        executed_tools: this.computeExecutedTools(
          derived?.message_tools ?? [],
          it.context_variables,
          it as unknown as Record<string, unknown>,
        ),
      };
    });
  }

  /** Réplica server-side das etapas 2 e 3 de extractSessionTools do frontend:
   *  inferência de ferramentas via context_variables e heurísticas de negócio. */
  private computeExecutedTools(
    messageTools: string[],
    contextVariables: unknown,
    item: Record<string, unknown>,
  ): string[] {
    const vars = (contextVariables || {}) as Record<string, any>;
    const tools = new Set<string>(
      messageTools.filter((t) => typeof t === 'string' && t.trim()),
    );

    const rawVarsTools =
      vars.tool_calls || vars.toolCalls || vars.executed_tools || vars.tools;
    if (Array.isArray(rawVarsTools)) {
      for (const t of rawVarsTools) {
        const name =
          typeof t === 'string' ? t : t?.name || t?.function?.name || t?.tool;
        if (name) tools.add(String(name));
      }
    }

    if (vars.cpf || vars.cliente_cpf || item.client_identifier)
      tools.add('buscar_cpf');
    if (vars.offers || vars.ofertas || vars.selected_offer || vars.propostas)
      tools.add('offers');
    if (
      vars.acordo_id ||
      vars.agreement_id ||
      item.agreement_id ||
      item.is_agreement_reached
    )
      tools.add('agreement');
    if (vars.pix_code || vars.codigo_pix || vars.chave_pix)
      tools.add('gerar_pix');

    return Array.from(tools).filter(Boolean);
  }

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

    // Lista enxuta: apenas colunas escalares + context_variables (sem o JSONB
    // pesado de messages). Os campos derivados de diálogo são calculados no banco.
    const items = await this.prisma.painel_interactions.findMany({
      where: where as any,
      ...this.interactionListArgs,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    });

    const [enrichedItems, total] = await Promise.all([
      this.attachInteractionDerivedFields(companyId, items),
      this.prisma.painel_interactions.count({ where: where as any }),
    ]);

    return {
      items: enrichedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Detalhe completo de uma interação (inclui messages e context_variables)
   *  para o modal do relatório, sempre validado por company_id. Campos derivados
   *  pesados (transcript completo e ferramentas executadas) só são calculados aqui. */
  async getInteractionDetail(companyId: string, id: string) {
    if (!UUID_SHAPE_REGEX.test(id)) return null;
    const item = await this.prisma.painel_interactions.findFirst({
      where: { id, company_id: companyId },
    });
    if (!item) return null;
    const [enriched] = await this.attachInteractionDerivedFields(
      companyId,
      [item],
      true,
    );
    return enriched;
  }

  /** Mensagens completas de um lote de interações da página atual
   *  (usado pela visualização de curadoria e exportação CSV no frontend). */
  async getInteractionsMessages(companyId: string, ids: string[]) {
    const validIds = Array.from(
      new Set(ids.filter((id) => UUID_SHAPE_REGEX.test(id))),
    ).slice(0, 200);
    if (validIds.length === 0) return [];

    return this.prisma.$queryRaw<Array<{ id: string; messages: unknown }>>(
      Prisma.sql`
        SELECT id, messages
        FROM painel_interactions
        WHERE company_id = ${companyId}::uuid AND id = ANY(${validIds}::uuid[])
      `,
    );
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
    const runConditions: Prisma.Sql[] = [
      Prisma.sql`company_id = ${companyId}::uuid`,
    ];
    if (opts.from) runConditions.push(Prisma.sql`started_at >= ${opts.from}`);
    if (opts.to) runConditions.push(Prisma.sql`started_at <= ${opts.to}`);

    const interactionConditions: Prisma.Sql[] = [
      Prisma.sql`company_id = ${companyId}::uuid`,
    ];
    if (opts.clientId)
      interactionConditions.push(
        Prisma.sql`client_id = ${opts.clientId}::uuid`,
      );
    if (opts.from)
      interactionConditions.push(Prisma.sql`created_at >= ${opts.from}`);
    if (opts.to)
      interactionConditions.push(Prisma.sql`created_at <= ${opts.to}`);

    const [runRows, interactionRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          key: string | null;
          provider: string | null;
          total_runs: number;
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          cost_usd: number;
          avg_latency_ms: number;
          p95_latency_ms: number;
          g_model: number;
          g_provider: number;
        }>
      >(
        Prisma.sql`
          WITH runs AS (
            SELECT
              COALESCE(NULLIF(provider, ''), 'desconhecido') AS provider,
              COALESCE(NULLIF(model, ''), 'desconhecido') AS model,
              COALESCE(input_tokens, 0)::int AS input_tokens,
              COALESCE(output_tokens, 0)::int AS output_tokens,
              COALESCE(
                NULLIF(total_tokens, 0),
                COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0),
                0
              )::int AS total_tokens,
              COALESCE(cost, 0)::float8 AS cost,
              COALESCE(latency_ms, 0)::int AS latency_ms
            FROM agent_runs
            WHERE ${Prisma.join(runConditions, ' AND ')}
          )
          SELECT
            COALESCE(model, provider) AS key,
            MIN(provider) AS provider,
            COUNT(*)::int AS total_runs,
            COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
            COALESCE(SUM(total_tokens), 0)::float8 AS total_tokens,
            COALESCE(SUM(cost), 0)::float8 AS cost_usd,
            COALESCE(AVG(latency_ms) FILTER (WHERE latency_ms > 0), 0)::float8 AS avg_latency_ms,
            COALESCE(
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE latency_ms > 0),
              0
            )::float8 AS p95_latency_ms,
            GROUPING(model)::int AS g_model,
            GROUPING(provider)::int AS g_provider
          FROM runs
          GROUP BY GROUPING SETS ((model), (provider), ())
        `,
      ),
      this.prisma.$queryRaw<
        Array<{
          interactions: number;
          voice_duration_seconds: number;
          barge_ins: number;
          total_tokens: number;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
        }>
      >(
        Prisma.sql`
          SELECT
            COUNT(*)::int AS interactions,
            COALESCE(SUM(duration_seconds) FILTER (WHERE channel LIKE '%voice%'), 0)::int AS voice_duration_seconds,
            COALESCE(SUM(barge_in_count) FILTER (WHERE channel LIKE '%voice%'), 0)::int AS barge_ins,
            COALESCE(SUM(total_tokens), 0)::float8 AS total_tokens,
            COALESCE(SUM(prompt_tokens), 0)::float8 AS input_tokens,
            COALESCE(SUM(completion_tokens), 0)::float8 AS output_tokens,
            COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost_usd
          FROM painel_interactions
          WHERE ${Prisma.join(interactionConditions, ' AND ')}
        `,
      ),
    ]);

    const runTotals = runRows.find(
      (r) => r.g_model === 1 && r.g_provider === 1,
    );
    const interactionTotals = interactionRows[0];
    const hasRuns = (runTotals?.total_runs ?? 0) > 0;

    const byModel = runRows
      .filter((r) => r.g_model === 0)
      .map((r) => ({
        model: r.key || 'desconhecido',
        provider: r.provider || 'desconhecido',
        total_runs: r.total_runs,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        total_tokens: r.total_tokens,
        cost_usd: r.cost_usd,
        avg_latency_ms: r.avg_latency_ms,
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens);

    const byProvider = runRows
      .filter((r) => r.g_provider === 0 && r.g_model === 1)
      .map((r) => ({
        provider: r.key || 'desconhecido',
        runs: r.total_runs,
        tokens: r.total_tokens,
        cost_usd: r.cost_usd,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    const totalTokens = hasRuns
      ? (runTotals?.total_tokens ?? 0)
      : (interactionTotals?.total_tokens ?? 0);
    const inputTokens = hasRuns
      ? (runTotals?.input_tokens ?? 0)
      : (interactionTotals?.input_tokens ?? 0);
    const outputTokens = hasRuns
      ? (runTotals?.output_tokens ?? 0)
      : (interactionTotals?.output_tokens ?? 0);
    const totalCostUsd = hasRuns
      ? (runTotals?.cost_usd ?? 0)
      : (interactionTotals?.cost_usd ?? 0);

    return {
      totals: {
        total_runs:
          runTotals?.total_runs || interactionTotals?.interactions || 0,
        total_tokens: totalTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_cost_usd: Number(totalCostUsd.toFixed(4)),
        total_cost_brl: Number((totalCostUsd * 5.5).toFixed(2)),
        voice_duration_minutes: Math.round(
          (interactionTotals?.voice_duration_seconds ?? 0) / 60,
        ),
        total_barge_ins: interactionTotals?.barge_ins ?? 0,
        p95_latency_ms: runTotals?.p95_latency_ms ?? 0,
      },
      by_model: byModel,
      by_provider: byProvider,
    };
  }
}
