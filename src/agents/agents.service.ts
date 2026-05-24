import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentsRepository } from './repositories/agents.repository';

@Injectable()
export class AgentsService {
  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly metadataService: ClientMetadataService,
    private readonly prisma: PrismaService,
  ) {}

  private async getUserCompanyId(userId: string): Promise<string> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) {
      throw new ForbiddenException('Usuário sem empresa vinculada');
    }
    return user.company_id;
  }

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Client not found`);
    }
  }

  async create(
    clientId: string,
    createAgentDto: CreateAgentDto | Record<string, unknown>,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    const agent = await this.agentsRepository.create(clientId, createAgentDto as Record<string, unknown>);
    if (agent) void this.metadataService.refresh(agent.client_id);
    return agent;
  }

  async findAll(userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    return this.prisma.painel_agents.findMany({
      where: { painel_clients: { company_id: companyId } },
      include: { painel_clients: { select: { company_name: true } } },
      orderBy: { execution_order: 'asc' },
    });
  }

  async findAllByClient(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    return this.agentsRepository.findAllByClient(clientId);
  }

  async findOne(id: string, userId: string) {
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    const companyId = await this.getUserCompanyId(userId);
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    return agent;
  }

  async update(
    id: string,
    updateAgentDto: UpdateAgentDto | Record<string, unknown>,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    const updated = await this.agentsRepository.update(id, updateAgentDto as Record<string, unknown>);
    if (updated) void this.metadataService.refresh(updated.client_id);
    return updated;
  }

  async remove(id: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    const { agent: removedAgent, result } = await this.agentsRepository.remove(id);
    if (removedAgent) void this.metadataService.refresh(removedAgent.client_id);
    return result;
  }
}
