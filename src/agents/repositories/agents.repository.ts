import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class AgentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, payload: Record<string, unknown>) {
    return this.prisma.painel_agents.create({
      data: { ...payload, client_id: clientId } as any,
    });
  }

  async findAllByClient(clientId: string) {
    return this.prisma.painel_agents.findMany({
      where: { client_id: clientId },
      orderBy: { execution_order: 'asc' },
    });
  }

  async findOne(id: string) {
    const agent = await this.prisma.painel_agents.findUnique({
      where: { id },
    });
    if (!agent) throw new NotFoundException(`Agent with ID ${id} not found`);
    return agent;
  }

  async update(id: string, payload: Record<string, unknown>) {
    return this.prisma.painel_agents.update({
      where: { id },
      data: payload as any,
    });
  }

  async remove(id: string) {
    const agent = await this.findOne(id);
    await this.prisma.painel_agents.delete({ where: { id } });
    return { agent, result: { success: true } };
  }
}
