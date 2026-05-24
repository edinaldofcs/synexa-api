import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async getAgentRun(agentRunId: string) {
    const run = await this.prisma.agent_runs.findUnique({
      where: { id: agentRunId },
      include: {
        tool_calls: { orderBy: { created_at: 'asc' } },
        inbound_message: { include: { message_parts: { orderBy: { order_index: 'asc' } } } },
        response_message: { include: { message_parts: { orderBy: { order_index: 'asc' } } } },
      },
    });
    if (!run) throw new NotFoundException('Agent run not found');
    return run;
  }

  async listAgentRuns(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    request_id?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.status) where.status = params.status;

    const [data, total] = await Promise.all([
      this.prisma.agent_runs.findMany({
        where,
        orderBy: { started_at: 'desc' },
        take: params.limit || 50,
        skip: params.offset || 0,
      }),
      this.prisma.agent_runs.count({ where }),
    ]);

    return { data, total, limit: params.limit || 50, offset: params.offset || 0 };
  }

  async listToolCalls(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    agent_run_id?: string;
    request_id?: string;
    tool_name?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.agent_run_id) where.agent_run_id = params.agent_run_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.tool_name) where.tool_name = params.tool_name;
    if (params.status) where.status = params.status;

    const [data, total] = await Promise.all([
      this.prisma.tool_calls.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: params.limit || 50,
        skip: params.offset || 0,
      }),
      this.prisma.tool_calls.count({ where }),
    ]);

    return { data, total, limit: params.limit || 50, offset: params.offset || 0 };
  }

  async listMessageEvents(params: {
    company_id?: string;
    client_id?: string;
    conversation_id?: string;
    message_id?: string;
    request_id?: string;
    event_type?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.conversation_id) where.conversation_id = params.conversation_id;
    if (params.message_id) where.message_id = params.message_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.event_type) where.event_type = params.event_type;

    const [data, total] = await Promise.all([
      this.prisma.message_events.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: params.limit || 50,
        skip: params.offset || 0,
      }),
      this.prisma.message_events.count({ where }),
    ]);

    return { data, total, limit: params.limit || 50, offset: params.offset || 0 };
  }

  async getInboundEvent(inboundEventId: string) {
    const event = await this.prisma.inbound_events.findUnique({
      where: { id: inboundEventId },
    });
    if (!event) throw new NotFoundException('Inbound event not found');
    return event;
  }

  async listInboundEvents(params: {
    company_id?: string;
    client_id?: string;
    request_id?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (params.company_id) where.company_id = params.company_id;
    if (params.client_id) where.client_id = params.client_id;
    if (params.request_id) where.request_id = params.request_id;
    if (params.status) where.status = params.status;

    const [data, total] = await Promise.all([
      this.prisma.inbound_events.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: params.limit || 50,
        skip: params.offset || 0,
      }),
      this.prisma.inbound_events.count({ where }),
    ]);

    return { data, total, limit: params.limit || 50, offset: params.offset || 0 };
  }

  async getTraceByRequestId(requestId: string) {
    const [inboundEvents, agentRuns, toolCalls, messageEvents] = await Promise.all([
      this.prisma.inbound_events.findMany({ where: { request_id: requestId } }),
      this.prisma.agent_runs.findMany({
        where: { request_id: requestId },
        include: { tool_calls: true },
      }),
      this.prisma.tool_calls.findMany({ where: { request_id: requestId } }),
      this.prisma.message_events.findMany({ where: { request_id: requestId } }),
    ]);

    return {
      request_id: requestId,
      inbound_events: inboundEvents,
      agent_runs: agentRuns,
      tool_calls: toolCalls,
      message_events: messageEvents,
    };
  }
}
