import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { AgentsRepository } from '../agents/repositories/agents.repository';
import { ApisRepository } from '../apis/repositories/apis.repository';
import { IntentionsRepository } from '../intentions/repositories/intentions.repository';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { LlmConfigDto } from './dto/llm-config.dto';
import { ClientsRepository } from './repositories/clients.repository';
import { encrypt, decrypt } from '../common/utils/crypto.util';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly clientsRepository: ClientsRepository,
    private readonly agentsRepository: AgentsRepository,
    private readonly intentionsRepository: IntentionsRepository,
    private readonly apisRepository: ApisRepository,
    private readonly metadataService: ClientMetadataService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }
  }

  async create(
    createClientDto: CreateClientDto,
    userId: string,
    userCompanyId: string | null,
  ) {
    const { user_id, ...rest } = createClientDto;

    const companyId = userCompanyId;

    if (!companyId) {
      if (!user_id) throw new BadRequestException('User ID is required');

      const user = await this.prisma.users.findUnique({
        where: { id: user_id },
        select: { company_id: true },
      });

      if (!user?.company_id) {
        throw new NotFoundException(
          `User with ID ${user_id} not found or has no company associated.`,
        );
      }
    }

    const finalCompanyId = companyId || (await this.getUserCompanyId(userId));

    const client = await this.clientsRepository.create({
      ...rest,
      company_id: finalCompanyId,
    });

    if (client) void this.metadataService.refresh(client.id);
    return client;
  }

  async findAll(userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    return this.prisma.painel_clients.findMany({
      where: { company_id: companyId },
      orderBy: { id: 'asc' },
    });
  }

  async findOne(id: string, userId?: string) {
    const client = await this.clientsRepository.findOne(id);
    if (userId) {
      const companyId = await this.getUserCompanyId(userId);
      if (client.company_id !== companyId) {
        throw new NotFoundException(`Client with ID ${id} not found`);
      }
    }
    return client;
  }

  async update(id: string, updateClientDto: UpdateClientDto, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(id, companyId);
    const client = await this.clientsRepository.update(
      id,
      updateClientDto as Record<string, unknown>,
    );
    if (client) void this.metadataService.refresh(client.id);
    return client;
  }

  async remove(id: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(id, companyId);
    return this.clientsRepository.remove(id);
  }

  async duplicate(
    clientId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const originalClient = await this.findOne(clientId);

    const clientData = {
      ...(originalClient as unknown as Record<string, unknown>),
    };
    delete clientData.id;
    const newClient = await this.clientsRepository.duplicate({
      ...clientData,
      company_name: `${String(originalClient.company_name || '')} (C\u00f3pia)`,
      agent_name: `${String(originalClient.agent_name || '')} (C\u00f3pia)`,
      metadata: {},
    });

    if (!newClient) throw new BadRequestException('Failed to duplicate client');

    const originalAgents =
      await this.agentsRepository.findAllByClient(clientId);
    const agentIdMap = new Map<string, string>();

    for (const agent of originalAgents || []) {
      const agentData = { ...(agent as unknown as Record<string, unknown>) };
      const oldAgentId = agentData.id;
      delete agentData.id;
      delete agentData.client_id;
      const newAgent = await this.agentsRepository.create(
        newClient.id,
        agentData,
      );
      if (newAgent) agentIdMap.set(String(oldAgentId), String(newAgent.id));
    }

    const originalIntentions =
      await this.intentionsRepository.findAllByClient(clientId);
    for (const intention of originalIntentions || []) {
      const intentionData = {
        ...(intention as unknown as Record<string, unknown>),
      };
      delete intentionData.id;
      delete intentionData.client_id;
      await this.intentionsRepository.create(newClient.id, intentionData);
    }

    const originalApis = await this.apisRepository.findAllByClient(clientId);
    const apiIdMap = new Map<string, string>();

    for (const api of originalApis || []) {
      if (!api) continue;
      const apiData = { ...(api as unknown as Record<string, unknown>) };
      const oldApiId = apiData.id;
      const agent_id = apiData.agent_id;
      delete apiData.id;
      delete apiData.agent_id;
      delete apiData.next_api_id;
      const newAgentId = agentIdMap.get(String(agent_id));
      if (!newAgentId) continue;

      const newApi = await this.apisRepository.create(newAgentId, {
        ...apiData,
        next_api_id: null,
      });
      if (newApi) apiIdMap.set(String(oldApiId), String(newApi.id));
    }

    for (const api of originalApis || []) {
      if (!api?.next_api_id) continue;
      const newApiId = apiIdMap.get(String(api.id));
      const newNextApiId = apiIdMap.get(String(api.next_api_id));
      if (newApiId && newNextApiId) {
        await this.apisRepository.update(newApiId, {
          next_api_id: newNextApiId,
        });
      }
    }

    void this.metadataService.refresh(newClient.id);
    return newClient;
  }

  async getLlmConfig(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    const client = await this.clientsRepository.findOne(clientId);
    const providers = (client.metadata as any)?.llm_providers || {};

    return { providers: this.decryptLlmProviders(providers) };
  }

  private decryptLlmProviders(
    providers: Record<string, any>,
  ): Record<string, any> {
    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey) return providers;

    try {
      const decrypted: Record<string, any> = {};
      for (const [key, config] of Object.entries(providers)) {
        decrypted[key] = { ...config };
        if (
          config?.apiKey &&
          typeof config.apiKey === 'string' &&
          config.apiKey.startsWith('enc:')
        ) {
          try {
            decrypted[key].apiKey = decrypt(
              config.apiKey.slice(4),
              encryptionKey,
            );
          } catch {
            decrypted[key].apiKey = config.apiKey;
          }
        }
      }
      return decrypted;
    } catch {
      return providers;
    }
  }

  private encryptLlmProviders(
    providers: Record<string, any>,
  ): Record<string, any> {
    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey) return providers;

    try {
      const encrypted: Record<string, any> = {};
      for (const [key, config] of Object.entries(providers)) {
        encrypted[key] = { ...config };
        if (
          config?.apiKey &&
          typeof config.apiKey === 'string' &&
          !config.apiKey.startsWith('enc:')
        ) {
          encrypted[key].apiKey =
            `enc:${encrypt(config.apiKey, encryptionKey)}`;
        }
      }
      return encrypted;
    } catch {
      return providers;
    }
  }

  private normalizeLlmProviders(providers: unknown) {
    if (!providers || typeof providers !== 'object') return {};

    return Object.fromEntries(
      Object.entries(providers as Record<string, any>).map(
        ([providerId, config]) => [
          providerId,
          {
            apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
            enabledModels: Array.isArray(config?.enabledModels)
              ? config.enabledModels.filter(
                  (model: unknown): model is string =>
                    typeof model === 'string',
                )
              : [],
          },
        ],
      ),
    );
  }

  async saveLlmConfig(clientId: string, body: LlmConfigDto, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);
    const client = await this.clientsRepository.findOne(clientId);
    const metadata =
      typeof client.metadata === 'object' && client.metadata !== null
        ? { ...(client.metadata as Record<string, unknown>) }
        : {};
    metadata.llm_providers = this.encryptLlmProviders(
      this.normalizeLlmProviders(body?.providers),
    );
    metadata.llm_providers_updated_at = new Date().toISOString();
    return this.clientsRepository.update(clientId, { metadata });
  }
}
