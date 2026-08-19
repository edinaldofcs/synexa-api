import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { sanitize } from '../common/utils/sanitize-log.util';

const MAX_PAYLOAD_CHARS = 200;

function truncatePayload(payload: unknown): unknown {
  if (typeof payload === 'string' && payload.length > MAX_PAYLOAD_CHARS) {
    return payload.substring(0, MAX_PAYLOAD_CHARS) + '...';
  }
  if (payload && typeof payload === 'object') {
    const str = JSON.stringify(payload);
    if (str.length > MAX_PAYLOAD_CHARS) {
      return str.substring(0, MAX_PAYLOAD_CHARS) + '...';
    }
    return payload;
  }
  return payload;
}

function sanitizeAgentRun(run: any): any {
  if (!run) return run;
  const cleaned = { ...run };
  delete cleaned.ai_context;
  delete cleaned.metadata;
  cleaned.raw_payload = truncatePayload(cleaned.raw_payload);
  if (cleaned.tool_calls) {
    cleaned.tool_calls = cleaned.tool_calls.map(sanitizeToolCall);
  }
  return sanitize(cleaned, 4);
}

function sanitizeToolCall(tc: any): any {
  if (!tc) return tc;
  const cleaned = { ...tc };
  delete cleaned.input;
  delete cleaned.output;
  cleaned.raw_payload = truncatePayload(cleaned.raw_payload);
  return sanitize(cleaned, 4);
}

function sanitizeMessageEvent(ev: any): any {
  if (!ev) return ev;
  const cleaned = { ...ev };
  delete cleaned.payload;
  delete cleaned.metadata;
  cleaned.raw_payload = truncatePayload(cleaned.raw_payload);
  return sanitize(cleaned, 4);
}

function sanitizeInboundEvent(ev: any): any {
  if (!ev) return ev;
  const cleaned = { ...ev };
  cleaned.raw_payload = truncatePayload(cleaned.raw_payload);
  delete cleaned.ai_context;
  delete cleaned.metadata;
  return sanitize(cleaned, 4);
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async getAgentRun(agentRunId: string) {
    const run = await this.prisma.agent_runs.findUnique({
      where: { id: agentRunId },
      include: {
        tool_calls: { orderBy: { created_at: 'asc' } },
        inbound_message: {
          include: { message_parts: { orderBy: { order_index: 'asc' } } },
        },
        response_message: {
          include: { message_parts: { orderBy: { order_index: 'asc' } } },
        },
      },
    });
    if (!run) throw new NotFoundException('Agent run not found');
    return sanitizeAgentRun(run);
  }

  async listAgentRuns(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    request_id?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.status) where.status = params.status;

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.agent_runs.findMany({
        where,
        orderBy: { started_at: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.agent_runs.count({ where }),
    ]);

    return {
      data: data.map(sanitizeAgentRun),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async listToolCalls(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    agent_run_id?: string;
    request_id?: string;
    tool_name?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.agent_run_id) where.agent_run_id = params.agent_run_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.tool_name) where.tool_name = params.tool_name;
    if (params.status) where.status = params.status;

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.tool_calls.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.tool_calls.count({ where }),
    ]);

    return {
      data: data.map(sanitizeToolCall),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async listMessageEvents(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    message_id?: string;
    request_id?: string;
    event_type?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.message_id) where.message_id = params.message_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.event_type) where.event_type = params.event_type;

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.message_events.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.message_events.count({ where }),
    ]);

    return {
      data: data.map(sanitizeMessageEvent),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getInboundEvent(inboundEventId: string) {
    const event = await this.prisma.inbound_events.findUnique({
      where: { id: inboundEventId },
    });
    if (!event) throw new NotFoundException('Inbound event not found');
    return sanitizeInboundEvent(event);
  }

  async listInboundEvents(params: {
    company_id?: string;
    client_id?: string;
    request_id?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.status) where.status = params.status;

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.inbound_events.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.inbound_events.count({ where }),
    ]);

    return {
      data: data.map(sanitizeInboundEvent),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getTraceByRequestId(requestId: string) {
    const [inboundEvents, agentRuns, toolCalls, messageEvents] =
      await Promise.all([
        this.prisma.inbound_events.findMany({
          where: { request_id: requestId },
        }),
        this.prisma.agent_runs.findMany({
          where: { request_id: requestId },
          include: { tool_calls: true },
        }),
        this.prisma.tool_calls.findMany({ where: { request_id: requestId } }),
        this.prisma.message_events.findMany({
          where: { request_id: requestId },
        }),
      ]);

    return {
      request_id: requestId,
      inbound_events: inboundEvents.map(sanitizeInboundEvent),
      agent_runs: agentRuns.map(sanitizeAgentRun),
      tool_calls: toolCalls.map(sanitizeToolCall),
      message_events: messageEvents.map(sanitizeMessageEvent),
    };
  }

  async getMetricsSummary(params: { company_id: string; client_id?: string }) {
    const where: any = { company_id: params.company_id };
    if (params.client_id) where.client_id = params.client_id;

    const [runs, credentials] = await Promise.all([
      this.prisma.agent_runs.findMany({
        where,
        select: {
          id: true,
          provider: true,
          model: true,
          status: true,
          latency_ms: true,
          input_tokens: true,
          output_tokens: true,
          total_tokens: true,
          cost: true,
          started_at: true,
        },
      }),
      this.prisma.provider_credentials.findMany({
        where: params.client_id
          ? { company_id: params.company_id, client_id: params.client_id }
          : { company_id: params.company_id },
        select: {
          provider: true,
          status: true,
          health_status: true,
          last_tested_at: true,
          last_used_at: true,
          enabled_models: true,
        },
      }),
    ]);

    const totalRuns = runs.length;
    let successfulRuns = 0;
    let failedRuns = 0;
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    const byProvider: Record<
      string,
      {
        runs: number;
        cost: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    > = {};

    for (const r of runs) {
      if (r.status === 'success') successfulRuns++;
      if (r.status === 'failed') failedRuns++;

      const cost = Number(r.cost) || 0;
      const inTok = Number(r.input_tokens) || 0;
      const outTok = Number(r.output_tokens) || 0;
      const totTok = Number(r.total_tokens) || inTok + outTok;

      totalCost += cost;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;

      if (r.latency_ms) {
        totalLatency += r.latency_ms;
        latencyCount++;
      }

      const pKey = (r.provider || 'unknown').toLowerCase();
      if (!byProvider[pKey]) {
        byProvider[pKey] = {
          runs: 0,
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
      }
      byProvider[pKey].runs++;
      byProvider[pKey].cost += cost;
      byProvider[pKey].inputTokens += inTok;
      byProvider[pKey].outputTokens += outTok;
      byProvider[pKey].totalTokens += totTok;
    }

    const avgLatencyMs =
      latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;
    const successRate =
      totalRuns > 0 ? Math.round((successfulRuns / totalRuns) * 100) : 100;

    return {
      total_runs: totalRuns,
      successful_runs: successfulRuns,
      failed_runs: failedRuns,
      success_rate: successRate,
      total_cost: Number(totalCost.toFixed(6)),
      total_tokens: totalInputTokens + totalOutputTokens,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      avg_latency_ms: avgLatencyMs,
      by_provider: byProvider,
      providers_health: credentials.map((c) => ({
        provider: c.provider,
        status: c.status,
        health_status: c.health_status || 'unknown',
        last_tested_at: c.last_tested_at,
        last_used_at: c.last_used_at,
        enabled_models_count: Array.isArray(c.enabled_models)
          ? c.enabled_models.length
          : 0,
      })),
    };
  }

  async listCredentialAuditLogs(params: {
    company_id: string;
    client_id?: string;
    provider?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = { company_id: params.company_id };
    if (params.client_id) where.client_id = params.client_id;
    if (params.provider) where.provider = params.provider.toLowerCase();

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.credential_audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.credential_audit_logs.count({ where }),
    ]);

    return {
      data: data.map((d) => sanitize(d, 4)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
