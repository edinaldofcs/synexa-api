import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { WebSearchConfigDto } from './dto/web-search-config.dto';
import {
  PreviewPromptDto,
  SimulateSequenceDto,
} from './dto/agent-simulation.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { ApiToolExecutorService } from '../orchestrator/services/api-tool-executor.service';

@Controller()
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly apiToolExecutor: ApiToolExecutorService,
  ) {}

  /**
   * Catálogo RESOLVIDO de tools do agente (APIs + nativas + subagentes),
   * no mesmo formato exibido ao LLM em runtime. Uso: painel de agentes e
   * telas de desenvolvimento/depuração de tools.
   */
  @Get('clients/:clientId/agents/:agentId/tools')
  async listAgentTools(
    @Param('clientId') clientId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    const agent = await this.agentsService.findOne(agentId, user.company_id);
    const catalog = await this.apiToolExecutor.loadAgentTools({
      clientId,
      agent: {
        id: agent.id,
        allowed_tool_names: agent.allowed_tool_names,
        transitions: agent.transitions,
      },
      agentConfig: this.apiToolExecutor.buildAgentConfigFromRecord(agent),
    });
    return {
      agent_id: agent.id,
      tools: catalog.apiTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        kind: tool.functionName?.startsWith('subagent_')
          ? 'subagent'
          : tool.method === 'NATIVE'
            ? 'native'
            : 'api',
        function_name: tool.functionName,
        parameters: tool.parameters,
      })),
      available_tool_names: catalog.availableTools,
    };
  }

  @Get('agents')
  findAll(@CurrentUser() user: { company_id: string }) {
    return this.agentsService.findAll(user.company_id);
  }

  @Post('clients/:clientId/agents/preview-prompt')
  previewPrompt(
    @Param('clientId') clientId: string,
    @Body() dto: PreviewPromptDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.previewPrompt(clientId, dto, user.company_id);
  }

  @Post('clients/:clientId/agents/simulate-sequence')
  simulateSequence(
    @Param('clientId') clientId: string,
    @Body() dto: SimulateSequenceDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.simulateSequence(clientId, dto, user.company_id);
  }

  @Post('clients/:clientId/agents')
  create(
    @Param('clientId') clientId: string,
    @Body() createAgentDto: CreateAgentDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.create(clientId, createAgentDto, user.company_id);
  }

  @Get('clients/:clientId/agents')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.findAllByClient(clientId, user.company_id);
  }

  @Get('agents/web-search')
  getAllWebSearchConfigs(@CurrentUser() user: { company_id: string }) {
    return this.agentsService.getAllWebSearchConfigs(user.company_id);
  }

  @Get('agents/:agentId')
  findOne(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.findOne(agentId, user.company_id);
  }

  @Get('agents/:agentId/web-search')
  getWebSearchConfig(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.getWebSearchConfig(agentId, user.company_id);
  }

  @Patch('agents/:agentId/web-search')
  updateWebSearchConfig(
    @Param('agentId') agentId: string,
    @Body() dto: WebSearchConfigDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.updateWebSearchConfig(
      agentId,
      dto,
      user.company_id,
    );
  }

  @Patch('agents/:agentId')
  update(
    @Param('agentId') agentId: string,
    @Body() updateAgentDto: UpdateAgentDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.update(agentId, updateAgentDto, user.company_id);
  }

  @Delete('agents/:agentId')
  remove(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.agentsService.remove(agentId, user.company_id);
  }
}
