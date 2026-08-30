import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { AgentsRepository } from '../agents/repositories/agents.repository';
import { ApisRepository } from '../apis/repositories/apis.repository';
import { TracksRepository } from '../tracks/repositories/tracks.repository';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { LlmConfigDto } from './dto/llm-config.dto';
import { ClientsRepository } from './repositories/clients.repository';
import { encrypt, decrypt } from '../common/utils/crypto.util';
import { CredentialAuditService } from '../common/services/credential-audit.service';
import { TelephonyEndpointResolverService } from '../voice/services/telephony-endpoint-resolver.service';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly clientsRepository: ClientsRepository,
    private readonly agentsRepository: AgentsRepository,
    private readonly tracksRepository: TracksRepository,
    private readonly apisRepository: ApisRepository,
    private readonly metadataService: ClientMetadataService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly credentialAuditService: CredentialAuditService,
    private readonly telephonyResolver: TelephonyEndpointResolverService,
  ) {}

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }
  }

  /**
   * Garante que o DID/ramal não pertence a outra empresa (chave única global
   * did_number_provider). Consulta cross-tenant via raw query pois a extensão
   * de escopo de tenant mascara registros de outros tenants no findFirst.
   */
  private async assertDidOwnership(
    didNumber: string,
    provider: string,
    companyId: string,
  ) {
    const rows = await this.prisma.$queryRaw<{ company_id: string }[]>(
      Prisma.sql`
        SELECT company_id
        FROM telephony_endpoints
        WHERE did_number = ${didNumber} AND provider = ${provider}
        LIMIT 1
      `,
    );
    const owner = rows?.[0];
    if (owner && owner.company_id !== companyId) {
      throw new ConflictException(
        `Ramal ${didNumber} (${provider}) já está em uso por outra empresa`,
      );
    }
  }

  async create(createClientDto: CreateClientDto, companyId: string) {
    if (!companyId) {
      throw new ForbiddenException('Usuário sem empresa vinculada');
    }

    const { user_id, sip_extension, telephony_provider, ...rest } =
      createClientDto;

    const client = await this.clientsRepository.create({
      ...rest,
      company_id: companyId,
    });

    // Se informado ramal telefônico/SIP, cria o endpoint de roteamento
    if (client && sip_extension?.trim()) {
      const ext = sip_extension.trim();
      const provider = (
        telephony_provider?.trim() || 'audiosocket'
      ).toLowerCase();
      try {
        await this.assertDidOwnership(ext, provider, companyId);
        await this.prisma.telephony_endpoints.upsert({
          where: {
            did_number_provider: {
              did_number: ext,
              provider,
            },
          },
          create: {
            company_id: companyId,
            client_id: client.id,
            provider,
            did_number: ext,
            label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
            audio_format: 'g711_ulaw',
            enabled: true,
          },
          update: {
            company_id: companyId,
            client_id: client.id,
            label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
            enabled: true,
            updated_at: new Date(),
          },
        });
        await this.telephonyResolver.invalidate(ext);
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `Falha ao provisionar ramal ${ext} para cliente ${client.id}: ${err.message}`,
        );
      }
    }

    if (client) void this.metadataService.refresh(client.id);
    return {
      ...client,
      sip_extension: sip_extension?.trim() || null,
      telephony_provider: telephony_provider?.trim() || 'audiosocket',
    };
  }

  async findAll(companyId: string) {
    const clients = await this.prisma.painel_clients.findMany({
      where: { company_id: companyId },
      include: {
        telephony_endpoints: {
          select: {
            id: true,
            did_number: true,
            provider: true,
            agent_step: true,
            label: true,
            enabled: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    return clients.map((c) => {
      const primaryEndpoint = c.telephony_endpoints?.[0];
      return {
        ...c,
        sip_extension: primaryEndpoint?.did_number || null,
        telephony_provider: primaryEndpoint?.provider || null,
      };
    });
  }

  async findOne(id: string, companyId?: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id },
      include: {
        telephony_endpoints: {
          select: {
            id: true,
            did_number: true,
            provider: true,
            agent_step: true,
            label: true,
            enabled: true,
          },
        },
      },
    });
    if (!client) throw new NotFoundException(`Client with ID ${id} not found`);
    if (companyId) {
      if (client.company_id !== companyId) {
        throw new NotFoundException(`Client with ID ${id} not found`);
      }
    }
    const primaryEndpoint = client.telephony_endpoints?.[0];
    return {
      ...client,
      sip_extension: primaryEndpoint?.did_number || null,
      telephony_provider: primaryEndpoint?.provider || null,
    };
  }

  async update(
    id: string,
    updateClientDto: UpdateClientDto,
    companyId: string,
  ) {
    await this.validateClientAccess(id, companyId);

    const { sip_extension, telephony_provider, ...restDto } = updateClientDto;

    const client = await this.clientsRepository.update(
      id,
      restDto as Record<string, unknown>,
    );

    // Sincronização do ramal/DID em telephony_endpoints
    if (sip_extension !== undefined) {
      const ext = sip_extension ? sip_extension.trim() : '';
      const provider = (
        telephony_provider?.trim() || 'audiosocket'
      ).toLowerCase();

      try {
        const existing = await this.prisma.telephony_endpoints.findFirst({
          where: { client_id: id, company_id: companyId },
        });

        if (ext) {
          if (
            existing &&
            (existing.did_number !== ext || existing.provider !== provider)
          ) {
            await this.prisma.telephony_endpoints.delete({
              where: { id: existing.id },
            });
            await this.telephonyResolver.invalidate(existing.did_number);
          }

          await this.assertDidOwnership(ext, provider, companyId);
          await this.prisma.telephony_endpoints.upsert({
            where: {
              did_number_provider: {
                did_number: ext,
                provider,
              },
            },
            create: {
              company_id: companyId,
              client_id: id,
              provider,
              did_number: ext,
              label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
              audio_format: 'g711_ulaw',
              enabled: true,
            },
            update: {
              company_id: companyId,
              client_id: id,
              label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
              enabled: true,
              updated_at: new Date(),
            },
          });
          await this.telephonyResolver.invalidate(ext);
        } else if (existing) {
          await this.prisma.telephony_endpoints.delete({
            where: { id: existing.id },
          });
          await this.telephonyResolver.invalidate(existing.did_number);
        }
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `Falha ao atualizar ramal ${ext} para cliente ${id}: ${err.message}`,
        );
      }
    }

    if (client) void this.metadataService.refresh(client.id);
    return this.findOne(id, companyId);
  }

  async remove(id: string, companyId: string) {
    await this.validateClientAccess(id, companyId);
    return this.clientsRepository.remove(id);
  }

  async duplicate(
    clientId: string,
    companyId: string,
  ): Promise<Record<string, unknown>> {
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

    const originalTracks =
      await this.tracksRepository.findAllByClient(clientId);
    for (const track of originalTracks || []) {
      const trackData = { ...(track as unknown as Record<string, unknown>) };
      const oldAgentId = trackData.agent_id;
      delete trackData.id;
      delete trackData.client_id;
      delete trackData.agent_id;
      const newAgentId = agentIdMap.get(String(oldAgentId));
      await this.tracksRepository.create(newClient.id, {
        ...trackData,
        ...(newAgentId ? { agent_id: newAgentId } : {}),
      });
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

    const originalSubagents = await this.prisma.painel_subagents.findMany({
      where: { client_id: clientId },
    });
    for (const subagent of originalSubagents || []) {
      const subagentData = {
        ...(subagent as unknown as Record<string, unknown>),
      };
      delete subagentData.id;
      delete subagentData.client_id;
      delete subagentData.created_at;
      delete subagentData.updated_at;
      await this.prisma.painel_subagents.create({
        data: {
          ...subagentData,
          client_id: newClient.id,
        } as any,
      });
    }

    void this.metadataService.refresh(newClient.id);
    return newClient;
  }

  async getLlmConfig(clientId: string, companyId: string, userId: string) {
    await this.validateClientAccess(clientId, companyId);

    // 1. Busca credenciais da tabela dedicada provider_credentials
    const dbCredentials = await this.prisma.provider_credentials.findMany({
      where: { client_id: clientId },
    });

    const client = await this.clientsRepository.findOne(clientId);
    const legacyProviders = (client.metadata as any)?.llm_providers || {};
    const decryptedLegacy = this.decryptLlmProviders(legacyProviders);

    const masked: Record<string, any> = {};

    // Prioriza registros da tabela provider_credentials
    for (const cred of dbCredentials) {
      let rawKey = cred.api_key_enc;
      if (rawKey && rawKey.startsWith('enc:')) {
        const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
        if (encryptionKey) {
          try {
            rawKey = decrypt(rawKey.slice(4), encryptionKey);
          } catch {
            rawKey = '';
          }
        }
      }

      const hasStoredKey = Boolean(rawKey && rawKey.trim().length > 0);
      masked[cred.provider] = {
        hasStoredKey,
        apiKey: hasStoredKey ? this.maskApiKey(rawKey) : '',
        enabledModels: Array.isArray(cred.enabled_models)
          ? cred.enabled_models
          : [],
        healthStatus: cred.health_status || 'unknown',
        lastTestedAt: cred.last_tested_at || null,
        lastUsedAt: cred.last_used_at || null,
      };
    }

    // Complementa com provedores do metadata que possam não estar ainda no provider_credentials
    for (const [key, config] of Object.entries(decryptedLegacy)) {
      if (!masked[key]) {
        const rawKey = config?.apiKey || '';
        const hasStoredKey = Boolean(rawKey && rawKey.length > 0);
        masked[key] = {
          hasStoredKey,
          apiKey: hasStoredKey ? this.maskApiKey(rawKey) : '',
          enabledModels: config?.enabledModels || [],
          healthStatus: 'unknown',
          lastTestedAt: null,
          lastUsedAt: null,
        };
      }
    }

    // Registra trilha de auditoria não-bloqueante
    void this.credentialAuditService.logAction({
      companyId,
      clientId,
      userId,
      provider: 'all',
      action: 'viewed',
    });

    return { providers: masked };
  }

  private maskApiKey(key?: string): string {
    if (!key || typeof key !== 'string') return '';
    const clean = key.trim();
    if (clean.length <= 8) return '********';
    return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
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
    existingProviders: Record<string, any> = {},
  ): Record<string, any> {
    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');

    try {
      const encrypted: Record<string, any> = {};
      for (const [key, config] of Object.entries(providers)) {
        encrypted[key] = { ...config };
        const newKey = config?.apiKey ? String(config.apiKey).trim() : '';

        // Se a chave enviada for uma máscara (ex: 'AIza...1234' ou '********') ou vazia, mantém a existente
        if (!newKey || newKey.includes('...') || newKey === '********') {
          if (existingProviders[key]?.apiKey) {
            encrypted[key].apiKey = existingProviders[key].apiKey;
          } else {
            encrypted[key].apiKey = '';
          }
          continue;
        }

        if (encryptionKey && !newKey.startsWith('enc:')) {
          encrypted[key].apiKey = `enc:${encrypt(newKey, encryptionKey)}`;
        } else {
          encrypted[key].apiKey = newKey;
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

  async saveLlmConfig(
    clientId: string,
    body: LlmConfigDto,
    companyId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.validateClientAccess(clientId, companyId);
    const client = await this.clientsRepository.findOne(clientId);
    const metadata =
      typeof client.metadata === 'object' && client.metadata !== null
        ? { ...(client.metadata as Record<string, unknown>) }
        : {};

    const existingProviders =
      (metadata.llm_providers as Record<string, any>) || {};
    const normalized = this.normalizeLlmProviders(body?.providers);

    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');

    // 1. Sincroniza cada provedor com a tabela provider_credentials e registra auditoria
    for (const [providerName, config] of Object.entries(normalized)) {
      const pKey = providerName.toLowerCase();
      const inputApiKey = config.apiKey ? String(config.apiKey).trim() : '';
      const enabledModels = config.enabledModels || [];

      // Consulta credencial existente no banco
      const existingCred = await this.prisma.provider_credentials.findFirst({
        where: {
          client_id: clientId,
          provider: pKey,
          label: 'default',
        },
      });

      const isMasked =
        inputApiKey.includes('...') || inputApiKey === '********';
      const isUnchanged =
        isMasked || (!inputApiKey && existingCred?.api_key_enc);

      if (isUnchanged) {
        // Se a chave não mudou, verifica se os modelos habilitados mudaram
        if (existingCred) {
          const prevModels = Array.isArray(existingCred.enabled_models)
            ? (existingCred.enabled_models as string[]).slice().sort().join(',')
            : '';
          const nextModels = enabledModels.slice().sort().join(',');
          const modelsChanged = prevModels !== nextModels;

          if (modelsChanged) {
            await this.prisma.provider_credentials.update({
              where: { id: existingCred.id },
              data: {
                enabled_models: enabledModels,
                updated_at: new Date(),
              },
            });
            void this.credentialAuditService.logAction({
              companyId,
              clientId,
              userId,
              provider: pKey,
              action: 'updated',
              ipAddress,
              userAgent,
              metadata: { enabled_models_count: enabledModels.length },
            });
          }
        }
      } else if (inputApiKey && inputApiKey !== '') {
        // Nova chave enviada -> criptografa
        const finalEncKey =
          encryptionKey && !inputApiKey.startsWith('enc:')
            ? `enc:${encrypt(inputApiKey, encryptionKey)}`
            : inputApiKey;

        const action = existingCred ? 'rotated' : 'created';

        await this.prisma.provider_credentials.upsert({
          where: {
            client_id_provider_label: {
              client_id: clientId,
              provider: pKey,
              label: 'default',
            },
          },
          update: {
            api_key_enc: finalEncKey,
            enabled_models: enabledModels,
            status: 'active',
            updated_at: new Date(),
          },
          create: {
            company_id: companyId,
            client_id: clientId,
            provider: pKey,
            api_key_enc: finalEncKey,
            label: 'default',
            status: 'active',
            enabled_models: enabledModels,
            created_by: userId,
          },
        });

        void this.credentialAuditService.logAction({
          companyId,
          clientId,
          userId,
          provider: pKey,
          action,
          ipAddress,
          userAgent,
          metadata: {
            key_fingerprint: this.maskApiKey(inputApiKey),
            enabled_models_count: enabledModels.length,
          },
        });
      } else if (!inputApiKey && existingCred) {
        // Chave foi limpa -> revoga
        await this.prisma.provider_credentials.update({
          where: { id: existingCred.id },
          data: {
            status: 'revoked',
            updated_at: new Date(),
          },
        });

        void this.credentialAuditService.logAction({
          companyId,
          clientId,
          userId,
          provider: pKey,
          action: 'revoked',
          ipAddress,
          userAgent,
        });
      }
    }

    // 2. Mantém compatibilidade com metadata.llm_providers
    metadata.llm_providers = this.encryptLlmProviders(
      normalized,
      existingProviders,
    );
    metadata.llm_providers_updated_at = new Date().toISOString();
    return this.clientsRepository.update(clientId, { metadata });
  }
}
