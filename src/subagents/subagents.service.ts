import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateSubagentDto } from './dto/create-subagent.dto';
import { UpdateSubagentDto } from './dto/update-subagent.dto';

@Injectable()
export class SubagentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException('Cliente não encontrado');
    }
  }

  async findAllByClient(clientId: string, companyId: string) {
    await this.validateClientAccess(clientId, companyId);

    return this.prisma.painel_subagents.findMany({
      where: { client_id: clientId },
      orderBy: { created_at: 'asc' },
    });
  }

  async findOne(id: string, companyId: string) {
    const subagent = await this.prisma.painel_subagents.findUnique({
      where: { id },
      include: { painel_clients: { select: { company_id: true } } },
    });

    if (!subagent || subagent.painel_clients.company_id !== companyId) {
      throw new NotFoundException('Subagente não encontrado');
    }

    return subagent;
  }

  async create(clientId: string, dto: CreateSubagentDto, companyId: string) {
    await this.validateClientAccess(clientId, companyId);

    // Normaliza o nome para identificador seguro
    const safeName = dto.name.trim().toLowerCase().replace(/\s+/g, '_');

    return this.prisma.painel_subagents.create({
      data: {
        client_id: clientId,
        name: safeName,
        description: dto.description,
        system_prompt: dto.system_prompt,
        llm_provider: dto.llm_provider || 'gemini',
        model: dto.model || null,
        allowed_tool_names: dto.allowed_tool_names || [],
        allowed_knowledge_base_ids: dto.allowed_knowledge_base_ids || [],
        temperature: dto.temperature ?? 0.7,
        is_active: dto.is_active ?? true,
      },
    });
  }

  async update(id: string, dto: UpdateSubagentDto, companyId: string) {
    await this.findOne(id, companyId);

    const safeName = dto.name
      ? dto.name.trim().toLowerCase().replace(/\s+/g, '_')
      : undefined;

    return this.prisma.painel_subagents.update({
      where: { id },
      data: {
        ...(safeName && { name: safeName }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.system_prompt !== undefined && {
          system_prompt: dto.system_prompt,
        }),
        ...(dto.llm_provider !== undefined && {
          llm_provider: dto.llm_provider,
        }),
        ...(dto.model !== undefined && { model: dto.model }),
        ...(dto.allowed_tool_names !== undefined && {
          allowed_tool_names: dto.allowed_tool_names,
        }),
        ...(dto.allowed_knowledge_base_ids !== undefined && {
          allowed_knowledge_base_ids: dto.allowed_knowledge_base_ids,
        }),
        ...(dto.temperature !== undefined && { temperature: dto.temperature }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        updated_at: new Date(),
      },
    });
  }

  async remove(id: string, companyId: string) {
    await this.findOne(id, companyId);
    return this.prisma.painel_subagents.delete({
      where: { id },
    });
  }
}
