import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateIntentionDto } from './dto/create-intention.dto';
import { UpdateIntentionDto } from './dto/update-intention.dto';
import { IntentionsRepository } from './repositories/intentions.repository';

@Injectable()
export class IntentionsService {
  constructor(
    private readonly intentionsRepository: IntentionsRepository,
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
    createIntentionDto: CreateIntentionDto | Record<string, unknown>,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    return this.intentionsRepository.create(
      clientId,
      createIntentionDto as Record<string, unknown>,
    );
  }

  async findAllByClient(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    return this.intentionsRepository.findAllByClient(clientId);
  }

  async findOne(id: string, userId: string) {
    const intention = await this.intentionsRepository.findOne(id);
    const companyId = await this.getUserCompanyId(userId);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: intention.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Intention with ID ${id} not found`);
    }
    return intention;
  }

  async update(
    id: string,
    updateIntentionDto: UpdateIntentionDto | Record<string, unknown>,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    const intention = await this.intentionsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: intention.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Intention with ID ${id} not found`);
    }
    return this.intentionsRepository.update(
      id,
      updateIntentionDto as Record<string, unknown>,
    );
  }

  async remove(id: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    const intention = await this.intentionsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: intention.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Intention with ID ${id} not found`);
    }
    return this.intentionsRepository.remove(id);
  }
}
