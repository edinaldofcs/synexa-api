import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateTrackDto } from './dto/create-track.dto';
import { UpdateTrackDto } from './dto/update-track.dto';
import { TracksRepository } from './repositories/tracks.repository';

@Injectable()
export class TracksService {
  constructor(
    private readonly tracksRepository: TracksRepository,
    private readonly prisma: PrismaService,
  ) {}

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
    createTrackDto: CreateTrackDto | Record<string, unknown>,
    companyId: string,
  ) {
    await this.validateClientAccess(clientId, companyId);
    await this.validateAgentAccess(
      createTrackDto.agent_id,
      clientId,
      companyId,
    );
    return this.tracksRepository.create(
      clientId,
      createTrackDto as Record<string, unknown>,
    );
  }

  async findAllByClient(clientId: string, companyId: string) {
    await this.validateClientAccess(clientId, companyId);
    return this.tracksRepository.findAllByClient(clientId);
  }

  async findOne(id: string, companyId: string) {
    const track = await this.tracksRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: track.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Track with ID ${id} not found`);
    }
    return track;
  }

  async update(
    id: string,
    updateTrackDto: UpdateTrackDto | Record<string, unknown>,
    companyId: string,
  ) {
    const track = await this.tracksRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: track.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Track with ID ${id} not found`);
    }
    await this.validateAgentAccess(
      updateTrackDto.agent_id,
      track.client_id,
      companyId,
    );
    return this.tracksRepository.update(
      id,
      updateTrackDto as Record<string, unknown>,
    );
  }

  private async validateAgentAccess(
    agentId: unknown,
    clientId: string,
    companyId: string,
  ) {
    if (agentId === undefined || agentId === null) return;
    if (typeof agentId !== 'string' || !agentId) {
      throw new NotFoundException('Agente não encontrado');
    }
    const agent = await this.prisma.painel_agents.findFirst({
      where: {
        id: agentId,
        client_id: clientId,
        painel_clients: { company_id: companyId },
      },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
  }

  async remove(id: string, companyId: string) {
    const track = await this.tracksRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: track.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Track with ID ${id} not found`);
    }
    return this.tracksRepository.remove(id);
  }
}
