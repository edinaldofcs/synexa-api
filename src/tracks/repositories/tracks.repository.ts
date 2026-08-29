import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TracksRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, payload: Record<string, unknown>) {
    return this.prisma.painel_tracks.create({
      data: { ...payload, client_id: clientId } as any,
    });
  }

  async findAllByClient(clientId: string) {
    return this.prisma.painel_tracks.findMany({
      where: { client_id: clientId },
      orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
    });
  }

  async findOne(id: string) {
    const track = await this.prisma.painel_tracks.findUnique({
      where: { id },
    });
    if (!track) throw new NotFoundException(`Track with ID ${id} not found`);
    return track;
  }

  async update(id: string, payload: Record<string, unknown>) {
    return this.prisma.painel_tracks.update({
      where: { id },
      data: payload as any,
    });
  }

  async remove(id: string) {
    await this.prisma.painel_tracks.delete({ where: { id } });
    return { success: true };
  }
}
