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
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller()
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post('clients/:clientId/agents')
  create(
    @Param('clientId') clientId: string,
    @Body() createAgentDto: CreateAgentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.agentsService.create(clientId, createAgentDto, user.id);
  }

  @Get('clients/:clientId/agents')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.agentsService.findAllByClient(clientId, user.id);
  }

  @Get('agents/:agentId')
  findOne(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.agentsService.findOne(agentId, user.id);
  }

  @Patch('agents/:agentId')
  update(
    @Param('agentId') agentId: string,
    @Body() updateAgentDto: UpdateAgentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.agentsService.update(agentId, updateAgentDto, user.id);
  }

  @Delete('agents/:agentId')
  remove(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.agentsService.remove(agentId, user.id);
  }
}
