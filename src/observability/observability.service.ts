import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  QUEUE_INGESTION, QUEUE_AGENT, QUEUE_DISPATCHER, QUEUE_MEDIA, QUEUE_KNOWLEDGE, QUEUE_DEAD_LETTER,
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

  async getQueueMetrics() {
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
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
        ]);
        return { queue: name, waiting, active, completed, failed, delayed };
      }),
    );

    return metrics;
  }

  async getLatencyMetrics(hours: number = 24) {
    const since = new Date(Date.now() - hours * 3600_000);

    const agentRuns = await this.prisma.agent_runs.findMany({
      where: {
        started_at: { gte: since },
        status: { in: ['success', 'failed'] },
      },
      select: { latency_ms: true, status: true, model: true, started_at: true },
      orderBy: { started_at: 'desc' },
    });

    const latencies = agentRuns.filter(r => r.latency_ms != null).map(r => r.latency_ms!);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    const p95Latency = latencies.length > 0
      ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]
      : 0;
    const errorRate = agentRuns.length > 0
      ? Math.round((agentRuns.filter(r => r.status === 'failed').length / agentRuns.length) * 100)
      : 0;

    return {
      period_hours: hours,
      total_runs: agentRuns.length,
      avg_latency_ms: avgLatency,
      p95_latency_ms: p95Latency,
      error_rate_percent: errorRate,
      by_model: this.groupBy(agentRuns, 'model'),
    };
  }

  async getCostMetrics(hours: number = 168) {
    const since = new Date(Date.now() - hours * 3600_000);

    const runs = await this.prisma.agent_runs.findMany({
      where: { started_at: { gte: since }, status: 'success' },
      select: { cost: true, input_tokens: true, output_tokens: true, model: true, provider: true },
    });

    const totalCost = runs.reduce((sum, r) => sum + Number(r.cost || 0), 0);
    const totalTokens = runs.reduce((sum, r) => sum + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

    return {
      period_hours: hours,
      total_runs: runs.length,
      total_cost: totalCost,
      total_tokens: totalTokens,
      by_provider: this.groupBy(runs, 'provider'),
    };
  }

  async getErrorsByTenant(hours: number = 24) {
    const since = new Date(Date.now() - hours * 3600_000);

    const failedRuns = await this.prisma.agent_runs.groupBy({
      by: ['company_id', 'client_id'],
      where: { started_at: { gte: since }, status: 'failed' },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const total = await this.prisma.agent_runs.count({
      where: { started_at: { gte: since }, status: 'failed' },
    });

    return {
      period_hours: hours,
      total_failures: total,
      by_tenant: failedRuns.map(r => ({
        company_id: r.company_id,
        client_id: r.client_id,
        failures: r._count.id,
      })),
    };
  }

  private groupBy(items: any[], field: string): Record<string, number> {
    return items.reduce((acc: Record<string, number>, item: any) => {
      const key = String(item[field] || 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }
}
