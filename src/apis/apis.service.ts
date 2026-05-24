import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { ApisRepository } from './repositories/apis.repository';
import { CreateApiDto } from './dto/create-api.dto';
import { UpdateApiDto } from './dto/update-api.dto';

@Injectable()
export class ApisService {
  constructor(
    private readonly apisRepository: ApisRepository,
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
    payload: CreateApiDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    const api = await this.apisRepository.create(clientId, payload as any);
    void this.metadataService.refresh(clientId);
    return api;
  }

  async findAllByClient(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    return this.apisRepository.findAllByClient(clientId);
  }

  async findOne(id: string, userId: string) {
    const api = await this.apisRepository.findOne(id);
    const companyId = await this.getUserCompanyId(userId);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: (api as any).client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    return api;
  }

  async update(
    id: string,
    payload: UpdateApiDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    const existing = await this.apisRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: (existing as any).client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    const api = await this.apisRepository.update(id, payload as any);
    const clientId = (api as any)?.client_id;
    if (clientId) void this.metadataService.refresh(clientId);
    return api;
  }

  async remove(id: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    const existing = await this.apisRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: (existing as any).client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    const { api, result } = await this.apisRepository.remove(id);
    const clientId = (api as any)?.client_id;
    if (clientId) void this.metadataService.refresh(clientId);
    return result;
  }
}
