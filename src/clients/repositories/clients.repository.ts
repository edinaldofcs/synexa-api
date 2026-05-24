import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class ClientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(payload: Record<string, unknown>) {
    return this.prisma.painel_clients.create({ data: payload as any });
  }

  async findAll() {
    return this.prisma.painel_clients.findMany({
      orderBy: { id: 'asc' },
    });
  }

  async findOne(id: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id },
    });
    if (!client)
      throw new NotFoundException(`Client with ID ${id} not found`);
    return client;
  }

  async update(id: string, payload: Record<string, unknown>) {
    return this.prisma.painel_clients.update({
      where: { id },
      data: payload as any,
    });
  }

  async remove(id: string) {
    await this.prisma.painel_clients.delete({ where: { id } });
    return { success: true };
  }

  async duplicate(payload: Record<string, unknown>) {
    return this.prisma.painel_clients.create({ data: payload as any });
  }
}
