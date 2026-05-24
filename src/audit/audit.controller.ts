import { Controller, Get, Param, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('agent-runs')
  listAgentRuns(
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('request_id') request_id?: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.auditService.listAgentRuns({ company_id, client_id, conversation_id, request_id, status, limit, offset });
  }

  @Get('agent-runs/:id')
  getAgentRun(@Param('id') id: string) {
    return this.auditService.getAgentRun(id);
  }

  @Get('tool-calls')
  listToolCalls(
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('agent_run_id') agent_run_id?: string,
    @Query('request_id') request_id?: string,
    @Query('tool_name') tool_name?: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.auditService.listToolCalls({ company_id, client_id, conversation_id, agent_run_id, request_id, tool_name, status, limit, offset });
  }

  @Get('message-events')
  listMessageEvents(
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('message_id') message_id?: string,
    @Query('request_id') request_id?: string,
    @Query('event_type') event_type?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.auditService.listMessageEvents({ company_id, client_id, conversation_id, message_id, request_id, event_type, limit, offset });
  }

  @Get('inbound-events')
  listInboundEvents(
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('request_id') request_id?: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.auditService.listInboundEvents({ company_id, client_id, request_id, status, limit, offset });
  }

  @Get('inbound-events/:id')
  getInboundEvent(@Param('id') id: string) {
    return this.auditService.getInboundEvent(id);
  }

  @Get('trace/:requestId')
  getTraceByRequestId(@Param('requestId') requestId: string) {
    return this.auditService.getTraceByRequestId(requestId);
  }
}
