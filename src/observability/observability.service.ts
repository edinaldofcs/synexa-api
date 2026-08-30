import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  QUEUE_INGESTION,
  QUEUE_AGENT,
  QUEUE_DISPATCHER,
  QUEUE_MEDIA,
  QUEUE_KNOWLEDGE,
  QUEUE_DEAD_LETTER,
} from '../queue/queue.constants';

@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_INGESTION) private readonly ingestionQueue: Queue,
    @InjectQueue(QUEUE_AGENT) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_DISPATCHER) private readonly dispatcherQueue: Queue,
    @InjectQueue(QUEUE_MEDIA) private readonly mediaQueue: Queue,
    @InjectQueue(QUEUE_KNOWLEDGE) private readonly knowledgeQueue: Queue,
    @InjectQueue(QUEUE_DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {}

  async getQueueMetrics(companyId?: string | null) {
    const queues = [
      { name: 'ingestion', queue: this.ingestionQueue },
      { name: 'agent', queue: this.agentQueue },
      { name: 'dispatcher', queue: this.dispatcherQueue },
      { name: 'media', queue: this.mediaQueue },
      { name: 'knowledge', queue: this.knowledgeQueue },
      { name: 'dead-letter', queue: this.deadLetterQueue },
    ];

    const metrics = await Promise.all(
      queues.map(async ({ name, queue }) => {
        const [waiting, active, completed, failed, delayed] = await Promise.all(
          [
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
          ],
        );
        return {
          name,
          queue: name,
          waiting,
          active,
          completed,
          failed,
          delayed,
        };
      }),
    );

    return metrics;
  }

  async getLatencyMetrics(hours: number = 24, companyId?: string | null) {
    const since = new Date(Date.now() - hours * 3600_000);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`started_at >= ${since}`,
      Prisma.sql`status IN ('success', 'failed')`,
    ];
    if (companyId) conditions.push(Prisma.sql`company_id = ${companyId}::uuid`);
    const where = Prisma.join(conditions, ' AND ');

    const [metricsRows, modelRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          total_runs: number;
          failed_runs: number;
          avg_latency_ms: number;
          p95_latency_ms: number;
        }>
      >(
        Prisma.sql`
          /* obs_latency_metrics */
          SELECT
            COUNT(*)::int AS total_runs,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
            COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency_ms,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p95_latency_ms
          FROM agent_runs
          WHERE ${where}
        `,
      ),
      this.prisma.$queryRaw<Array<{ model: string; runs: number }>>(
        Prisma.sql`
          /* obs_latency_by_model */
          SELECT
            COALESCE(NULLIF(model, ''), 'unknown') AS model,
            COUNT(*)::int AS runs
          FROM agent_runs
          WHERE ${where}
          GROUP BY 1
        `,
      ),
    ]);

    const metrics = metricsRows[0] ?? {
      total_runs: 0,
      failed_runs: 0,
      avg_latency_ms: 0,
      p95_latency_ms: 0,
    };

    return {
      period_hours: hours,
      total_runs: Number(metrics.total_runs),
      avg_latency_ms: Math.round(Number(metrics.avg_latency_ms)),
      p95_latency_ms: Math.round(Number(metrics.p95_latency_ms)),
      error_rate_percent:
        Number(metrics.total_runs) > 0
          ? Math.round(
              (Number(metrics.failed_runs) / Number(metrics.total_runs)) * 100,
            )
          : 0,
      by_model: Object.fromEntries(
        modelRows.map((row) => [row.model, Number(row.runs)]),
      ),
    };
  }

  async getCostMetrics(hours: number = 168, companyId?: string | null) {
    const since = new Date(Date.now() - hours * 3600_000);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`started_at >= ${since}`,
      Prisma.sql`status = 'success'`,
    ];
    if (companyId) conditions.push(Prisma.sql`company_id = ${companyId}::uuid`);
    const where = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<
      Array<{
        provider: string;
        runs: number;
        total_cost: number;
        total_tokens: number;
      }>
    >(
      Prisma.sql`
        /* obs_cost_by_provider */
        SELECT
          COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
          COUNT(*)::int AS runs,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::float8 AS total_cost,
          COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::float8 AS total_tokens
        FROM agent_runs
        WHERE ${where}
        GROUP BY 1
      `,
    );

    let totalRuns = 0;
    let totalCost = 0;
    let totalTokens = 0;
    const byProvider: Record<string, number> = {};

    for (const row of rows) {
      totalRuns += Number(row.runs);
      totalCost += Number(row.total_cost);
      totalTokens += Number(row.total_tokens);
      byProvider[row.provider] = Number(row.runs);
    }

    return {
      period_hours: hours,
      total_runs: totalRuns,
      total_cost: totalCost,
      total_tokens: totalTokens,
      by_provider: byProvider,
    };
  }

  async getErrorsByTenant(hours: number = 24, companyId?: string | null) {
    const since = new Date(Date.now() - hours * 3600_000);

    const where: any = { started_at: { gte: since }, status: 'failed' };
    if (companyId) where.company_id = companyId;

    const failedRuns = await this.prisma.agent_runs.groupBy({
      by: ['company_id', 'client_id'],
      where,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const total = await this.prisma.agent_runs.count({
      where,
    });

    return {
      period_hours: hours,
      total_failures: total,
      by_tenant: failedRuns.map((r) => ({
        company_id: r.company_id,
        client_id: r.client_id,
        failures: r._count.id,
      })),
    };
  }
}
