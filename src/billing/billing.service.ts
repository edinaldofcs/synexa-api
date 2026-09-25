import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { UUID_SHAPE_REGEX } from '../common/validators/uuid-shape';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';

export interface ModelUsageSummary {
  model: string;
  provider: string;
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  billableBrl: number;
}

export interface BillingSummaryResponse {
  companyId: string;
  period: string;
  isByok: boolean;
  markupPercent: number;
  exchangeRate: number;
  totals: {
    totalInteractions: number;
    textInteractions: number;
    voiceInteractions: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    voiceDurationMinutes: number;
    rawCostUsd: number;
    billableCostUsd: number;
    billableCostBrl: number;
  };
  byModel: ModelUsageSummary[];
  byProvider: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

export interface DailyUsageItem {
  date: string;
  runs: number;
  tokens: number;
  voiceSeconds: number;
  costUsd: number;
  billableBrl: number;
}

export interface BillingWindowFilters {
  clientId?: string;
  from?: string;
  to?: string;
}

export interface VoiceMinutesTotals {
  sessions: number;
  durationSeconds: number;
  durationMinutes: number;
  forwardedSeconds: number;
  forwardedMinutes: number;
}

export interface VoiceMinutesByDay extends VoiceMinutesTotals {
  date: string;
}

export interface VoiceMinutesByClient extends VoiceMinutesTotals {
  clientId: string;
  clientName: string;
}

export interface VoiceMinutesByModel extends VoiceMinutesTotals {
  model: string;
  voiceName: string;
}

export interface VoiceMinutesResponse {
  companyId: string;
  from: string;
  to: string;
  totals: VoiceMinutesTotals;
  byDay: VoiceMinutesByDay[];
  byClient: VoiceMinutesByClient[];
  byModel: VoiceMinutesByModel[];
}

export interface TokensUsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  billableUsd: number;
  billableBrl: number;
}

export interface TokensUsageByModel extends TokensUsageTotals {
  model: string;
}

export interface TokensUsageByAgent extends TokensUsageTotals {
  agentId: string;
}

export interface TokensUsageResponse {
  companyId: string;
  from: string;
  to: string;
  totals: TokensUsageTotals;
  byModel: TokensUsageByModel[];
  byAgent: TokensUsageByAgent[];
}

interface AgentRunUsageRow {
  provider_key: string;
  model_key: string;
  total_runs: number;
  voice_runs: number;
  voice_seconds: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface VoiceMinutesRow {
  sessions: number;
  duration_seconds: number;
  forwarded_seconds: number;
}

interface AgentTokensRow {
  model_grp: number;
  agent_grp: number;
  model_key: string;
  agent_key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

const BILLING_CACHE_TTL_SECONDS = 45;
const MAX_WINDOW_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
    private readonly redisService: RedisService,
  ) {}

  async getUsageSummary(
    companyId: string,
    periodDate?: Date,
    filters: BillingWindowFilters = {},
  ): Promise<BillingSummaryResponse> {
    const clientId = this.assertOptionalClientId(filters.clientId);
    const useCustomWindow = Boolean(filters.from || filters.to);

    return this.withBillingCache(
      'summary',
      companyId,
      {
        from: filters.from ?? null,
        to: filters.to ?? null,
        clientId: clientId ?? null,
      },
      async () => {
        let windowFrom: Date;
        let windowTo: Date;

        if (useCustomWindow) {
          const window = this.resolveBillingWindow(filters.from, filters.to);
          windowFrom = window.from;
          windowTo = window.to;
        } else {
          const targetDate = periodDate || new Date();
          windowFrom = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            1,
          );
          windowTo = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth() + 1,
            0,
            23,
            59,
            59,
            999,
          );
        }

        const isByok = false; // Pode ser estendido baseado em provider_credentials ativos do tenant
        const markupPercent = this.pricingService.getMarkupPercent();
        const exchangeRate = this.pricingService.getExchangeRate();

        const clientIdCondition = clientId
          ? Prisma.sql`AND client_id = ${clientId}::uuid`
          : Prisma.empty;

        const usageRows = await this.prisma.$queryRaw<AgentRunUsageRow[]>(
          Prisma.sql`
            /* billing_usage_by_model */
            SELECT
              COALESCE(NULLIF(provider, ''), 'synexa') AS provider_key,
              COALESCE(NULLIF(model, ''), 'default') AS model_key,
              COUNT(*)::int AS total_runs,
              COUNT(*) FILTER (
                WHERE ${this.voiceRunFilter()}
              )::int AS voice_runs,
              COALESCE(
                SUM((trace ->> 'duration_seconds')::float8) FILTER (
                  WHERE ${this.voiceRunFilter()}
                ),
                0
              )::float8 AS voice_seconds,
              COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::float8 AS input_tokens,
              COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::float8 AS output_tokens,
              COALESCE(
                SUM(COALESCE(NULLIF(total_tokens, 0), COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))),
                0
              )::float8 AS total_tokens,
              COALESCE(SUM(COALESCE(cost, 0)), 0)::float8 AS cost_usd
            FROM agent_runs
            WHERE company_id = ${companyId}::uuid
              AND started_at >= ${windowFrom}
              AND started_at <= ${windowTo}
              ${clientIdCondition}
            GROUP BY 1, 2
          `,
        );

        let textInteractions = 0;
        let voiceInteractions = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalVoiceSeconds = 0;
        let rawCostUsd = 0;
        let totalInteractions = 0;

        const modelMap = new Map<string, ModelUsageSummary>();
        const providerMap: Record<
          string,
          { runs: number; tokens: number; costUsd: number }
        > = {};

        for (const row of usageRows) {
          const runs = Number(row.total_runs);
          const voiceRuns = Number(row.voice_runs);
          const inputTokens = Number(row.input_tokens);
          const outputTokens = Number(row.output_tokens);
          const totalTokens = Number(row.total_tokens);
          const cost = Number(row.cost_usd);

          totalInteractions += runs;
          voiceInteractions += voiceRuns;
          textInteractions += runs - voiceRuns;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalVoiceSeconds += Number(row.voice_seconds);
          rawCostUsd += cost;

          const modelKey = row.model_key;
          const providerKey = row.provider_key;

          if (!modelMap.has(modelKey)) {
            modelMap.set(modelKey, {
              model: modelKey,
              provider: providerKey,
              totalRuns: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              billableBrl: 0,
            });
          }

          const m = modelMap.get(modelKey)!;
          m.totalRuns += runs;
          m.inputTokens += inputTokens;
          m.outputTokens += outputTokens;
          m.totalTokens += totalTokens;
          m.costUsd += cost;

          if (!providerMap[providerKey]) {
            providerMap[providerKey] = { runs: 0, tokens: 0, costUsd: 0 };
          }
          providerMap[providerKey].runs += runs;
          providerMap[providerKey].tokens += totalTokens;
          providerMap[providerKey].costUsd += cost;
        }

        // Calcula faturamento com markup para cada modelo
        const byModel: ModelUsageSummary[] = Array.from(modelMap.values()).map(
          (item) => {
            const billable = this.pricingService.calculateBillable(
              item.costUsd,
              isByok,
            );
            return {
              ...item,
              costUsd: Number(item.costUsd.toFixed(6)),
              billableBrl: billable.billableCostBrl,
            };
          },
        );

        const totalBillable = this.pricingService.calculateBillable(
          rawCostUsd,
          isByok,
        );

        const periodStr = useCustomWindow
          ? `${windowFrom.toISOString().slice(0, 10)}..${windowTo.toISOString().slice(0, 10)}`
          : `${windowFrom.getFullYear()}-${String(windowFrom.getMonth() + 1).padStart(2, '0')}`;

        return {
          companyId,
          period: periodStr,
          isByok,
          markupPercent,
          exchangeRate,
          totals: {
            totalInteractions,
            textInteractions,
            voiceInteractions,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            voiceDurationMinutes: Number((totalVoiceSeconds / 60).toFixed(2)),
            rawCostUsd: Number(rawCostUsd.toFixed(6)),
            billableCostUsd: totalBillable.billableCostUsd,
            billableCostBrl: totalBillable.billableCostBrl,
          },
          byModel,
          byProvider: providerMap,
        };
      },
    );
  }

  async getDailyUsage(
    companyId: string,
    days = 30,
    filters: BillingWindowFilters = {},
  ): Promise<DailyUsageItem[]> {
    const clientId = this.assertOptionalClientId(filters.clientId);

    return this.withBillingCache(
      'daily',
      companyId,
      {
        days: filters.from || filters.to ? null : days,
        from: filters.from ?? null,
        to: filters.to ?? null,
        clientId: clientId ?? null,
      },
      async () => {
        const window = this.resolveBillingWindow(
          filters.from,
          filters.to,
          days,
        );

        const clientIdCondition = clientId
          ? Prisma.sql`AND client_id = ${clientId}::uuid`
          : Prisma.empty;

        const rows = await this.prisma.$queryRaw<
          Array<{
            date: string;
            runs: number;
            tokens: number;
            voice_seconds: number;
            cost_usd: number;
          }>
        >(
          Prisma.sql`
            /* billing_usage_by_day */
            SELECT
              to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS runs,
              COALESCE(SUM(COALESCE(NULLIF(total_tokens, 0), COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::float8 AS tokens,
              COALESCE(SUM((trace ->> 'duration_seconds')::float8), 0)::float8 AS voice_seconds,
              COALESCE(SUM(COALESCE(cost, 0)), 0)::float8 AS cost_usd
            FROM agent_runs
            WHERE company_id = ${companyId}::uuid
              AND started_at >= ${window.from}
              AND started_at <= ${window.to}
              ${clientIdCondition}
            GROUP BY 1
            ORDER BY 1 ASC
          `,
        );

        return rows.map((row) => {
          const costUsd = Number(row.cost_usd);
          const billable = this.pricingService.calculateBillable(
            costUsd,
            false,
          );
          return {
            date: row.date,
            runs: Number(row.runs),
            tokens: Number(row.tokens),
            voiceSeconds: Number(row.voice_seconds),
            costUsd: Number(costUsd.toFixed(6)),
            billableBrl: billable.billableCostBrl,
          };
        });
      },
    );
  }

  async getVoiceMinutes(
    companyId: string,
    params: {
      clientId?: string;
      from?: string;
      to?: string;
      days?: number;
    } = {},
  ): Promise<VoiceMinutesResponse> {
    const clientId = this.assertOptionalClientId(params.clientId);

    return this.withBillingCache(
      'voice-minutes',
      companyId,
      {
        from: params.from ?? null,
        to: params.to ?? null,
        days: params.days ?? null,
        clientId: clientId ?? null,
      },
      async () => {
        const window = this.resolveBillingWindow(
          params.from,
          params.to,
          params.days,
        );

        const [byDayRows, byClientRows, byModelRows] = await Promise.all([
          this.prisma.$queryRaw<
            Array<{
              date: string;
              sessions: number;
              duration_seconds: number;
              forwarded_seconds: number;
            }>
          >(
            Prisma.sql`
              /* billing_voice_minutes_by_day */
              SELECT
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                COUNT(*)::int AS sessions,
                COALESCE(SUM(COALESCE(duration_sec, 0)), 0)::float8 AS duration_seconds,
                COALESCE(SUM(COALESCE(audio_gate_forwarded_sec, 0)), 0)::float8 AS forwarded_seconds
              FROM voice_session_telemetry
              WHERE ${this.voiceTelemetryConditions(companyId, window, clientId)}
              GROUP BY 1
              ORDER BY 1 ASC
            `,
          ),
          this.prisma.$queryRaw<
            Array<{
              client_id: string;
              client_name: string;
              sessions: number;
              duration_seconds: number;
              forwarded_seconds: number;
            }>
          >(
            Prisma.sql`
              /* billing_voice_minutes_by_client */
              SELECT
                COALESCE(vst.client_id::text, 'unassigned') AS client_id,
                COALESCE(pc.company_name, pc.agent_name, 'Sem cliente') AS client_name,
                COUNT(*)::int AS sessions,
                COALESCE(SUM(COALESCE(vst.duration_sec, 0)), 0)::float8 AS duration_seconds,
                COALESCE(SUM(COALESCE(vst.audio_gate_forwarded_sec, 0)), 0)::float8 AS forwarded_seconds
              FROM voice_session_telemetry vst
              LEFT JOIN painel_clients pc ON pc.id = vst.client_id
              WHERE ${this.voiceTelemetryConditions(companyId, window, clientId, 'vst')}
              GROUP BY 1, 2
              ORDER BY sessions DESC
            `,
          ),
          this.prisma.$queryRaw<
            Array<{
              model: string;
              voice_name: string;
              sessions: number;
              duration_seconds: number;
              forwarded_seconds: number;
            }>
          >(
            Prisma.sql`
              /* billing_voice_minutes_by_model */
              SELECT
                COALESCE(NULLIF(model, ''), 'unknown') AS model,
                COALESCE(NULLIF(voice_name, 'default'), 'default') AS voice_name,
                COUNT(*)::int AS sessions,
                COALESCE(SUM(COALESCE(duration_sec, 0)), 0)::float8 AS duration_seconds,
                COALESCE(SUM(COALESCE(audio_gate_forwarded_sec, 0)), 0)::float8 AS forwarded_seconds
              FROM voice_session_telemetry
              WHERE ${this.voiceTelemetryConditions(companyId, window, clientId)}
              GROUP BY 1, 2
              ORDER BY sessions DESC
            `,
          ),
        ]);

        const byDay: VoiceMinutesByDay[] = byDayRows.map((row) => ({
          date: row.date,
          ...this.toVoiceMinutesItem(row),
        }));

        const byClient: VoiceMinutesByClient[] = byClientRows.map((row) => ({
          clientId: row.client_id,
          clientName: row.client_name,
          ...this.toVoiceMinutesItem(row),
        }));

        const byModel: VoiceMinutesByModel[] = byModelRows.map((row) => ({
          model: row.model,
          voiceName: row.voice_name,
          ...this.toVoiceMinutesItem(row),
        }));

        const totals = this.sumVoiceMinutes(byDay);

        return {
          companyId,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
          totals,
          byDay,
          byClient,
          byModel,
        };
      },
    );
  }

  async getTokensUsage(
    companyId: string,
    params: { clientId?: string; from?: string; to?: string } = {},
  ): Promise<TokensUsageResponse> {
    const clientId = this.assertOptionalClientId(params.clientId);

    return this.withBillingCache(
      'tokens',
      companyId,
      {
        from: params.from ?? null,
        to: params.to ?? null,
        clientId: clientId ?? null,
      },
      async () => {
        const window = this.resolveBillingWindow(params.from, params.to);

        const clientIdCondition = clientId
          ? Prisma.sql`AND ar.client_id = ${clientId}::uuid`
          : Prisma.empty;

        const rows = await this.prisma.$queryRaw<AgentTokensRow[]>(
          Prisma.sql`
            /* billing_tokens_by_grouping_sets */
            WITH normalized AS (
              SELECT
                COALESCE(NULLIF(ar.model, ''), 'default') AS model_key,
                COALESCE(ar.agent_id::text, 'none') AS agent_key,
                COALESCE(ar.input_tokens, 0) AS input_tokens,
                COALESCE(ar.output_tokens, 0) AS output_tokens,
                COALESCE(
                  NULLIF(ar.total_tokens, 0),
                  COALESCE(ar.input_tokens, 0) + COALESCE(ar.output_tokens, 0)
                ) AS total_tokens,
                COALESCE(ar.cost, 0) AS cost_usd
              FROM agent_runs ar
              WHERE ar.company_id = ${companyId}::uuid
                AND ar.started_at >= ${window.from}
                AND ar.started_at <= ${window.to}
                ${clientIdCondition}
            )
            SELECT
              GROUPING(model_key)::int AS model_grp,
              GROUPING(agent_key)::int AS agent_grp,
              CASE WHEN GROUPING(model_key) = 0 THEN model_key ELSE 'all' END AS model_key,
              CASE WHEN GROUPING(agent_key) = 0 THEN agent_key ELSE 'all' END AS agent_key,
              COUNT(*)::int AS runs,
              COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::float8 AS total_tokens,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
            FROM normalized
            GROUP BY GROUPING SETS ((model_key), (agent_key), ())
          `,
        );

        const toTokensItem = (row: AgentTokensRow) => {
          const costUsd = Number(row.cost_usd);
          const billable = this.pricingService.calculateBillable(
            costUsd,
            false,
          );
          return {
            runs: Number(row.runs),
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens),
            totalTokens: Number(row.total_tokens),
            costUsd: Number(costUsd.toFixed(6)),
            billableUsd: billable.billableCostUsd,
            billableBrl: billable.billableCostBrl,
          };
        };

        const byModel = rows
          .filter(
            (row) => Number(row.model_grp) === 0 && Number(row.agent_grp) === 1,
          )
          .map((row) => ({ model: row.model_key, ...toTokensItem(row) }));

        const byAgent = rows
          .filter(
            (row) => Number(row.model_grp) === 1 && Number(row.agent_grp) === 0,
          )
          .map((row) => ({ agentId: row.agent_key, ...toTokensItem(row) }));

        const totals = byModel.reduce<TokensUsageTotals>(
          (acc, item) => ({
            runs: acc.runs + item.runs,
            inputTokens: acc.inputTokens + item.inputTokens,
            outputTokens: acc.outputTokens + item.outputTokens,
            totalTokens: acc.totalTokens + item.totalTokens,
            costUsd: Number((acc.costUsd + item.costUsd).toFixed(6)),
            billableUsd: Number(
              (acc.billableUsd + item.billableUsd).toFixed(6),
            ),
            billableBrl: Number(
              (acc.billableBrl + item.billableBrl).toFixed(4),
            ),
          }),
          {
            runs: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            billableUsd: 0,
            billableBrl: 0,
          },
        );

        return {
          companyId,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
          totals,
          byModel,
          byAgent,
        };
      },
    );
  }

  private voiceRunFilter(): Prisma.Sql {
    // Sessões de voz marcadas no trace (gemini-live e cartesia-cascade/hybrid
    // gravam trace->>'type' = 'voice_session'); fallbacks por provider/model
    // preservam a contagem de registros legados sem marcação no trace.
    return Prisma.sql`(
      trace ->> 'type' = 'voice_session'
      OR provider = 'gemini-live'
      OR provider = 'cartesia-cascade'
      OR model LIKE '%live%'
    )`;
  }

  private assertOptionalClientId(clientId?: string): string | undefined {
    if (!clientId) return undefined;
    if (!UUID_SHAPE_REGEX.test(clientId)) {
      throw new BadRequestException(
        "Parâmetro 'client_id' deve ser um UUID válido",
      );
    }
    return clientId;
  }

  private resolveBillingWindow(
    from?: string,
    to?: string,
    days?: number,
  ): { from: Date; to: Date } {
    if (Boolean(from) !== Boolean(to)) {
      throw new BadRequestException(
        "Parâmetros 'from' e 'to' devem ser informados juntos",
      );
    }

    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new BadRequestException(
          "Parâmetros 'from' e 'to' devem ser datas ISO válidas",
        );
      }
      if (fromDate >= toDate) {
        throw new BadRequestException("'from' deve ser anterior a 'to'");
      }
      if (toDate.getTime() - fromDate.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
        throw new BadRequestException(
          `Janela máxima de ${MAX_WINDOW_DAYS} dias entre 'from' e 'to'`,
        );
      }
      return { from: fromDate, to: toDate };
    }

    const windowDays = days && days > 0 ? Math.min(days, MAX_WINDOW_DAYS) : 30;
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - windowDays * DAY_MS);
    return { from: fromDate, to: toDate };
  }

  private voiceTelemetryConditions(
    companyId: string,
    window: { from: Date; to: Date },
    clientId: string | undefined,
    prefix = '',
  ): Prisma.Sql {
    const col = (name: string) =>
      prefix ? Prisma.raw(`${prefix}.${name}`) : Prisma.raw(name);
    const clientIdCondition = clientId
      ? Prisma.sql`AND ${col('client_id')} = ${clientId}::uuid`
      : Prisma.empty;

    return Prisma.sql`
      ${col('company_id')} = ${companyId}::uuid
      AND ${col('created_at')} >= ${window.from}
      AND ${col('created_at')} <= ${window.to}
      ${clientIdCondition}
    `;
  }

  private toVoiceMinutesItem(row: {
    sessions: number;
    duration_seconds: number;
    forwarded_seconds: number;
  }): VoiceMinutesTotals {
    const durationSeconds = Number(row.duration_seconds);
    const forwardedSeconds = Number(row.forwarded_seconds);
    return {
      sessions: Number(row.sessions),
      durationSeconds,
      durationMinutes: Number((durationSeconds / 60).toFixed(2)),
      forwardedSeconds,
      forwardedMinutes: Number((forwardedSeconds / 60).toFixed(2)),
    };
  }

  private sumVoiceMinutes(items: VoiceMinutesTotals[]): VoiceMinutesTotals {
    return items.reduce<VoiceMinutesTotals>(
      (acc, item) => ({
        sessions: acc.sessions + item.sessions,
        durationSeconds: Number(
          (acc.durationSeconds + item.durationSeconds).toFixed(2),
        ),
        durationMinutes: Number(
          (acc.durationMinutes + item.durationMinutes).toFixed(2),
        ),
        forwardedSeconds: Number(
          (acc.forwardedSeconds + item.forwardedSeconds).toFixed(2),
        ),
        forwardedMinutes: Number(
          (acc.forwardedMinutes + item.forwardedMinutes).toFixed(2),
        ),
      }),
      {
        sessions: 0,
        durationSeconds: 0,
        durationMinutes: 0,
        forwardedSeconds: 0,
        forwardedMinutes: 0,
      },
    );
  }

  private async withBillingCache<T>(
    scope: string,
    companyId: string,
    cacheParams: Record<string, unknown>,
    loader: () => Promise<T>,
  ): Promise<T> {
    const paramsHash = createHash('sha256')
      .update(JSON.stringify(cacheParams))
      .digest('hex')
      .slice(0, 32);
    const cacheKey = `billing:${companyId}:${scope}:${paramsHash}`;

    try {
      const cached = await this.redisService.get<T>(cacheKey);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(
        `[Billing] Falha ao ler cache Redis (${scope}): ${err instanceof Error ? err.message : err}`,
      );
    }

    const result = await loader();

    try {
      await this.redisService.set(cacheKey, result, BILLING_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `[Billing] Falha ao gravar cache Redis (${scope}): ${err instanceof Error ? err.message : err}`,
      );
    }

    return result;
  }
}
