import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class IntentionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, payload: Record<string, unknown>) {
    return this.prisma.painel_intentions.create({
      data: { ...payload, client_id: clientId } as any,
    });
  }

  async findAllByClient(clientId: string) {
    return this.prisma.painel_intentions.findMany({
      where: { client_id: clientId },
      orderBy: { created_at: 'asc' },
    });
  }

  async findOne(id: string) {
    const intention = await this.prisma.painel_intentions.findUnique({
      where: { id },
    });
    if (!intention)
      throw new NotFoundException(`Intention with ID ${id} not found`);
    return intention;
  }

  async update(id: string, payload: Record<string, unknown>) {
    return this.prisma.painel_intentions.update({
      where: { id },
      data: payload as any,
    });
  }

  async remove(id: string) {
    await this.prisma.painel_intentions.delete({ where: { id } });
    return { success: true };
  }
}
