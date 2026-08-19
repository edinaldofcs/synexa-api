import {
  Controller,
  Get,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuditService } from './audit.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('summary')
  getMetricsSummary(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.auditService.getMetricsSummary({
      company_id: company_id || ctx.companyId,
      client_id,
    });
  }

  @Get('credentials')
  listCredentialAuditLogs(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('provider') provider?: string,
    @Query('page', new DefaultValuePipe(DEFAULT_PAGE), ParseIntPipe)
    page?: number,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit?: number,
  ) {
    const ctx = extractTenantContext(user);
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    return this.auditService.listCredentialAuditLogs({
      company_id: company_id || ctx.companyId,
      client_id,
      provider,
      page,
      limit: clampedLimit,
    });
  }

  @Get('agent-runs')
  listAgentRuns(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('request_id') request_id?: string,
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(DEFAULT_PAGE), ParseIntPipe)
    page?: number,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit?: number,
  ) {
    const ctx = extractTenantContext(user);
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    return this.auditService.listAgentRuns({
      company_id: company_id || ctx.companyId,
      client_id,
      conversation_id,
      request_id,
      status,
      page,
      limit: clampedLimit,
    });
  }

  @Get('agent-runs/:id')
  getAgentRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditService.getAgentRun(id);
  }

  @Get('tool-calls')
  listToolCalls(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('agent_run_id') agent_run_id?: string,
    @Query('request_id') request_id?: string,
    @Query('tool_name') tool_name?: string,
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(DEFAULT_PAGE), ParseIntPipe)
    page?: number,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit?: number,
  ) {
    const ctx = extractTenantContext(user);
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    return this.auditService.listToolCalls({
      company_id: company_id || ctx.companyId,
      client_id,
      conversation_id,
      agent_run_id,
      request_id,
      tool_name,
      status,
      page,
      limit: clampedLimit,
    });
  }

  @Get('message-events')
  listMessageEvents(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('conversation_id') conversation_id?: string,
    @Query('message_id') message_id?: string,
    @Query('request_id') request_id?: string,
    @Query('event_type') event_type?: string,
    @Query('page', new DefaultValuePipe(DEFAULT_PAGE), ParseIntPipe)
    page?: number,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit?: number,
  ) {
    const ctx = extractTenantContext(user);
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    return this.auditService.listMessageEvents({
      company_id: company_id || ctx.companyId,
      client_id,
      conversation_id,
      message_id,
      request_id,
      event_type,
      page,
      limit: clampedLimit,
    });
  }

  @Get('inbound-events')
  listInboundEvents(
    @CurrentUser() user: any,
    @Query('company_id') company_id?: string,
    @Query('client_id') client_id?: string,
    @Query('request_id') request_id?: string,
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(DEFAULT_PAGE), ParseIntPipe)
    page?: number,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit?: number,
  ) {
    const ctx = extractTenantContext(user);
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    return this.auditService.listInboundEvents({
      company_id: company_id || ctx.companyId,
      client_id,
      request_id,
      status,
      page,
      limit: clampedLimit,
    });
  }

  @Get('inbound-events/:id')
  getInboundEvent(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditService.getInboundEvent(id);
  }

  @Get('trace/:requestId')
  getTraceByRequestId(@Param('requestId') requestId: string) {
    return this.auditService.getTraceByRequestId(requestId);
  }
}
