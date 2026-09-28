import { Prisma } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class AgentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, payload: Record<string, unknown>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM painel_clients WHERE id = ${clientId}::uuid FOR UPDATE`,
      );
      if (payload.is_initial)
        await tx.painel_agents.updateMany({
          where: { client_id: clientId, is_initial: true },
          data: { is_initial: false },
        });
      return tx.painel_agents.create({
        data: { ...payload, client_id: clientId } as any,
      });
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
    const agent = await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM painel_clients WHERE id = ${agent.client_id}::uuid FOR UPDATE`,
      );
      if (payload.is_initial)
        await tx.painel_agents.updateMany({
          where: {
            client_id: agent.client_id,
            id: { not: id },
            is_initial: true,
          },
          data: { is_initial: false },
        });
      return tx.painel_agents.update({ where: { id }, data: payload as any });
    });
  }

  async remove(id: string) {
    const agent = await this.findOne(id);
    await this.prisma.painel_agents.delete({ where: { id } });
    return { agent, result: { success: true } };
  }
}
