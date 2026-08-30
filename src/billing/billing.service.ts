import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
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

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
  ) {}

  async getUsageSummary(
    companyId: string,
    periodDate?: Date,
  ): Promise<BillingSummaryResponse> {
    const targetDate = periodDate || new Date();
    const startOfMonth = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      1,
    );
    const endOfMonth = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    );

    const isByok = false; // Pode ser estendido baseado em provider_credentials ativos do tenant
    const markupPercent = this.pricingService.getMarkupPercent();
    const exchangeRate = this.pricingService.getExchangeRate();

    const usageRows = await this.prisma.$queryRaw<AgentRunUsageRow[]>(
      Prisma.sql`
        /* billing_usage_by_model */
        SELECT
          COALESCE(NULLIF(provider, ''), 'synexa') AS provider_key,
          COALESCE(NULLIF(model, ''), 'default') AS model_key,
          COUNT(*)::int AS total_runs,
          COUNT(*) FILTER (
            WHERE provider = 'gemini-live' OR model LIKE '%live%'
          )::int AS voice_runs,
          COALESCE(
            SUM((trace ->> 'duration_seconds')::float8) FILTER (
              WHERE provider = 'gemini-live' OR model LIKE '%live%'
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
          AND started_at >= ${startOfMonth}
          AND started_at <= ${endOfMonth}
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

    const periodStr = `${startOfMonth.getFullYear()}-${String(startOfMonth.getMonth() + 1).padStart(2, '0')}`;

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
  }

  async getDailyUsage(companyId: string, days = 30): Promise<DailyUsageItem[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

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
          AND started_at >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    );

    return rows.map((row) => {
      const costUsd = Number(row.cost_usd);
      const billable = this.pricingService.calculateBillable(costUsd, false);
      return {
        date: row.date,
        runs: Number(row.runs),
        tokens: Number(row.tokens),
        voiceSeconds: Number(row.voice_seconds),
        costUsd: Number(costUsd.toFixed(6)),
        billableBrl: billable.billableCostBrl,
      };
    });
  }
}
