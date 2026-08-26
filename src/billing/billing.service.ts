import { Injectable, Logger } from '@nestjs/common';
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
  plan: string;
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

    // Consulta empresa para obter o plano
    const company = await this.prisma.companies.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, plan: true },
    });

    const isByok = false; // Pode ser estendido baseado em provider_credentials ativos do tenant
    const markupPercent = this.pricingService.getMarkupPercent();
    const exchangeRate = this.pricingService.getExchangeRate();

    // Consulta agent_runs no mês para o tenant
    const runs = await this.prisma.agent_runs.findMany({
      where: {
        company_id: companyId,
        started_at: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
      select: {
        id: true,
        provider: true,
        model: true,
        input_tokens: true,
        output_tokens: true,
        total_tokens: true,
        cost: true,
        status: true,
        started_at: true,
        trace: true,
      },
    });

    let textInteractions = 0;
    let voiceInteractions = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalVoiceSeconds = 0;
    let rawCostUsd = 0;

    const modelMap = new Map<string, ModelUsageSummary>();
    const providerMap: Record<
      string,
      { runs: number; tokens: number; costUsd: number }
    > = {};

    for (const run of runs) {
      const isVoice =
        run.provider === 'gemini-live' ||
        (run.model && run.model.includes('live'));

      if (isVoice) {
        voiceInteractions++;
        const trace = (run.trace as any) || {};
        totalVoiceSeconds += trace.duration_seconds || 0;
      } else {
        textInteractions++;
      }

      const inputTokens = run.input_tokens || 0;
      const outputTokens = run.output_tokens || 0;
      const totalTokens = run.total_tokens || inputTokens + outputTokens;
      const cost = Number(run.cost || 0);

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      rawCostUsd += cost;

      const modelKey = run.model || 'default';
      const providerKey = run.provider || 'synexa';

      // Agrupamento por modelo
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
      m.totalRuns++;
      m.inputTokens += inputTokens;
      m.outputTokens += outputTokens;
      m.totalTokens += totalTokens;
      m.costUsd += cost;

      // Agrupamento por provedor
      if (!providerMap[providerKey]) {
        providerMap[providerKey] = { runs: 0, tokens: 0, costUsd: 0 };
      }
      providerMap[providerKey].runs++;
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
      plan: company?.plan || 'starter',
      totals: {
        totalInteractions: runs.length,
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

    const runs = await this.prisma.agent_runs.findMany({
      where: {
        company_id: companyId,
        started_at: { gte: since },
      },
      select: {
        started_at: true,
        total_tokens: true,
        input_tokens: true,
        output_tokens: true,
        cost: true,
        provider: true,
        trace: true,
      },
      orderBy: { started_at: 'asc' },
    });

    const dayMap = new Map<string, DailyUsageItem>();

    for (const run of runs) {
      const dateKey = (run.started_at || new Date())
        .toISOString()
        .split('T')[0];
      const tokens =
        run.total_tokens || (run.input_tokens || 0) + (run.output_tokens || 0);
      const cost = Number(run.cost || 0);
      const trace = (run.trace as any) || {};
      const voiceSec = trace.duration_seconds || 0;

      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, {
          date: dateKey,
          runs: 0,
          tokens: 0,
          voiceSeconds: 0,
          costUsd: 0,
          billableBrl: 0,
        });
      }

      const d = dayMap.get(dateKey)!;
      d.runs++;
      d.tokens += tokens;
      d.voiceSeconds += voiceSec;
      d.costUsd += cost;
    }

    return Array.from(dayMap.values()).map((d) => {
      const billable = this.pricingService.calculateBillable(d.costUsd, false);
      return {
        ...d,
        costUsd: Number(d.costUsd.toFixed(6)),
        billableBrl: billable.billableCostBrl,
      };
    });
  }
}
