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
import { TestVoiceProviderDto } from './dto/test-voice-provider.dto';
import {
  assertPublicHttpUrl,
  customHttpTimeout,
  MAX_CUSTOM_RESPONSE_BYTES,
} from '../common/utils/url-guard.util';
import { pcmToWav } from '../common/utils/pcm-wav.util';
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

  private async validateClientAccess(
    clientId: string,
    companyId: string,
    role?: string,
  ) {
    if (role === 'platform_admin') {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM painel_clients WHERE id = ${clientId}::uuid LIMIT 1`,
      );
      if (!rows || rows.length === 0) {
        throw new NotFoundException(`Client with ID ${clientId} not found`);
      }
      return;
    }

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client) {
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }
    if (client.company_id !== companyId) {
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }
  }

  /**
   * Obtém o próximo ramal de teste disponível na faixa 7001..7999
   */
  async getNextAvailableTestExtension(companyId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ did_number: string }[]>(
      Prisma.sql`
        SELECT did_number
        FROM telephony_endpoints
        WHERE did_number LIKE '7%'
      `,
    );
    const used = new Set(rows.map((r) => r.did_number));
    for (let ext = 7001; ext <= 7999; ext++) {
      const extStr = String(ext);
      if (!used.has(extStr)) {
        return extStr;
      }
    }
    return '7001';
  }

  /**
   * Garante que o DID/ramal não pertence a outra empresa nem a outro cliente.
   * did_number_provider é chave única global em telephony_endpoints.
   */
  private async assertDidAvailability(
    didNumber: string,
    provider: string,
    companyId: string,
    currentClientId?: string,
  ) {
    const rows = await this.prisma.$queryRaw<
      { company_id: string; client_id: string | null }[]
    >(
      Prisma.sql`
        SELECT company_id, client_id
        FROM telephony_endpoints
        WHERE did_number = ${didNumber} AND provider = ${provider}
        LIMIT 1
      `,
    );
    const existing = rows?.[0];
    if (existing) {
      if (existing.company_id !== companyId) {
        throw new ConflictException(
          `Ramal ${didNumber} (${provider}) já está em uso por outra empresa`,
        );
      }
      if (
        currentClientId &&
        existing.client_id &&
        existing.client_id !== currentClientId
      ) {
        throw new ConflictException(
          `Ramal ${didNumber} (${provider}) já está associado a outro cliente`,
        );
      }
    }
  }

  async create(createClientDto: CreateClientDto, companyId: string) {
    if (!companyId) {
      throw new ForbiddenException('Usuário sem empresa vinculada');
    }

    const {
      user_id,
      sip_extension,
      test_sip_extension,
      telephony_provider,
      audio_format,
      ...rest
    } = createClientDto;

    // Se informado ramal de teste, guarda no metadata do cliente
    const meta = (rest.metadata as Record<string, any>) || {};
    if (test_sip_extension?.trim()) {
      meta.test_sip_extension = test_sip_extension.trim();
    }
    rest.metadata = meta;

    const client = await this.clientsRepository.create({
      ...rest,
      company_id: companyId,
    });

    const provider = (
      telephony_provider?.trim() || 'audiosocket'
    ).toLowerCase();
    const codec = audio_format?.trim() || 'g711_ulaw';

    // 1. Se informado ramal de produção, cria o endpoint
    if (client && sip_extension?.trim()) {
      const ext = sip_extension.trim();
      try {
        await this.assertDidAvailability(ext, provider, companyId, client.id);
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
            audio_format: codec,
            enabled: true,
          },
          update: {
            company_id: companyId,
            client_id: client.id,
            label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
            audio_format: codec,
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

    // 2. Se informado ramal de testes, cria o endpoint de sandbox
    if (client && test_sip_extension?.trim()) {
      const testExt = test_sip_extension.trim();
      try {
        await this.assertDidAvailability(
          testExt,
          provider,
          companyId,
          client.id,
        );
        await this.prisma.telephony_endpoints.upsert({
          where: {
            did_number_provider: {
              did_number: testExt,
              provider,
            },
          },
          create: {
            company_id: companyId,
            client_id: client.id,
            provider,
            did_number: testExt,
            agent_step: 'test',
            label: `Ramal de Teste ${testExt} (Sandbox) - ${client.company_name || client.agent_name || 'Agente'}`,
            audio_format: codec,
            enabled: true,
          },
          update: {
            company_id: companyId,
            client_id: client.id,
            agent_step: 'test',
            label: `Ramal de Teste ${testExt} (Sandbox) - ${client.company_name || client.agent_name || 'Agente'}`,
            audio_format: codec,
            enabled: true,
            updated_at: new Date(),
          },
        });
        await this.telephonyResolver.invalidate(testExt);
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `Falha ao provisionar ramal de testes ${testExt} para cliente ${client.id}: ${err.message}`,
        );
      }
    }

    if (client) void this.metadataService.refresh(client.id);
    return {
      ...client,
      sip_extension: sip_extension?.trim() || null,
      test_sip_extension: test_sip_extension?.trim() || null,
      telephony_provider: provider,
      audio_format: codec,
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
            audio_format: true,
            label: true,
            enabled: true,
          },
          orderBy: { updated_at: 'desc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return clients.map((c) => {
      const prodEndpoint = c.telephony_endpoints?.find(
        (e) => e.agent_step !== 'test',
      );
      const testEndpoint = c.telephony_endpoints?.find(
        (e) => e.agent_step === 'test',
      );
      const meta = (c.metadata as Record<string, any>) || {};
      return {
        ...c,
        sip_extension: prodEndpoint?.did_number || null,
        test_sip_extension:
          testEndpoint?.did_number || meta.test_sip_extension || null,
        telephony_provider:
          prodEndpoint?.provider || testEndpoint?.provider || null,
        audio_format:
          prodEndpoint?.audio_format ||
          testEndpoint?.audio_format ||
          'g711_ulaw',
      };
    });
  }

  async findAllGlobal() {
    const clients = await this.prisma.painel_clients.findMany({
      where: {
        companies: {
          status: 'active',
        },
      },
      include: {
        companies: {
          select: { id: true, name: true },
        },
        telephony_endpoints: {
          select: {
            id: true,
            did_number: true,
            provider: true,
            agent_step: true,
            audio_format: true,
            label: true,
            enabled: true,
          },
        },
      },
      orderBy: [{ companies: { name: 'asc' } }, { company_name: 'asc' }],
    });

    return clients.map((c) => {
      const prodEndpoint = c.telephony_endpoints?.find(
        (e) => e.agent_step !== 'test',
      );
      const testEndpoint = c.telephony_endpoints?.find(
        (e) => e.agent_step === 'test',
      );
      const meta = (c.metadata as Record<string, any>) || {};
      return {
        ...c,
        // company_name NUNCA é mutado aqui: o sufixo "(Empresa)" era
        // absorvido pelo formData do painel e persistido a cada save
        // (duplicava "(Synexa Admin) (Synexa Admin)"). A associação com a
        // empresa vai em campo separado, apenas para exibição.
        company_label: c.companies?.name || null,
        sip_extension: prodEndpoint?.did_number || null,
        test_sip_extension:
          testEndpoint?.did_number || meta.test_sip_extension || null,
        telephony_provider:
          prodEndpoint?.provider || testEndpoint?.provider || null,
        audio_format:
          prodEndpoint?.audio_format ||
          testEndpoint?.audio_format ||
          'g711_ulaw',
      };
    });
  }

  async findOne(id: string, companyId?: string, role?: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id },
      include: {
        telephony_endpoints: {
          select: {
            id: true,
            did_number: true,
            provider: true,
            agent_step: true,
            audio_format: true,
            label: true,
            enabled: true,
          },
          orderBy: { updated_at: 'desc' },
        },
      },
    });
    if (!client) throw new NotFoundException(`Client with ID ${id} not found`);
    if (companyId && role !== 'platform_admin') {
      if (client.company_id !== companyId) {
        throw new NotFoundException(`Client with ID ${id} not found`);
      }
    }
    const prodEndpoint = client.telephony_endpoints?.find(
      (e) => e.agent_step !== 'test',
    );
    const testEndpoint = client.telephony_endpoints?.find(
      (e) => e.agent_step === 'test',
    );
    const meta = (client.metadata as Record<string, any>) || {};
    return {
      ...client,
      sip_extension: prodEndpoint?.did_number || null,
      test_sip_extension:
        testEndpoint?.did_number || meta.test_sip_extension || null,
      telephony_provider:
        prodEndpoint?.provider || testEndpoint?.provider || 'audiosocket',
      audio_format:
        prodEndpoint?.audio_format || testEndpoint?.audio_format || 'g711_ulaw',
    };
  }

  async update(
    id: string,
    updateClientDto: UpdateClientDto,
    companyId: string,
    role?: string,
  ) {
    await this.validateClientAccess(id, companyId, role);

    const {
      sip_extension,
      test_sip_extension,
      telephony_provider,
      audio_format,
      ...restDto
    } = updateClientDto;

    // Se test_sip_extension fornecido, sincroniza no metadata
    if (test_sip_extension !== undefined) {
      const currentMeta = (restDto.metadata as Record<string, any>) || {};
      restDto.metadata = {
        ...currentMeta,
        test_sip_extension: test_sip_extension
          ? test_sip_extension.trim()
          : null,
      };
    }

    const client = await this.clientsRepository.update(
      id,
      restDto as Record<string, unknown>,
    );

    const effectiveCompanyId = client.company_id || companyId;
    const provider = (
      telephony_provider?.trim() || 'audiosocket'
    ).toLowerCase();
    const codec = audio_format?.trim() || 'g711_ulaw';

    // 1. Sincronização do ramal de PRODUÇÃO (agent_step != 'test')
    if (sip_extension !== undefined) {
      const ext = sip_extension ? sip_extension.trim() : '';
      try {
        // Encontra TODOS os endpoints de produção atuais deste cliente
        const existingProds = await this.prisma.telephony_endpoints.findMany({
          where: {
            client_id: id,
            company_id: effectiveCompanyId,
            OR: [{ agent_step: null }, { agent_step: { not: 'test' } }],
          },
        });

        // Remove quaisquer endpoints de produção anteriores que não sejam o novo (ext + provider)
        for (const ep of existingProds) {
          if (!ext || ep.did_number !== ext || ep.provider !== provider) {
            await this.prisma.telephony_endpoints.delete({
              where: { id: ep.id },
            });
            await this.telephonyResolver.invalidate(ep.did_number);
          }
        }

        if (ext) {
          await this.assertDidAvailability(
            ext,
            provider,
            effectiveCompanyId,
            id,
          );
          await this.prisma.telephony_endpoints.upsert({
            where: {
              did_number_provider: {
                did_number: ext,
                provider,
              },
            },
            create: {
              company_id: effectiveCompanyId,
              client_id: id,
              provider,
              did_number: ext,
              label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
              audio_format: codec,
              enabled: true,
            },
            update: {
              company_id: effectiveCompanyId,
              client_id: id,
              label: `Ramal ${ext} - ${client.company_name || client.agent_name || 'Agente'}`,
              audio_format: codec,
              enabled: true,
              agent_step: null,
              updated_at: new Date(),
            },
          });
          await this.telephonyResolver.invalidate(ext);
        }
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `Falha ao atualizar ramal de produção ${ext} para cliente ${id}: ${err.message}`,
        );
      }
    }

    // 2. Sincronização do ramal de TESTES (agent_step = 'test')
    if (test_sip_extension !== undefined) {
      const testExt = test_sip_extension ? test_sip_extension.trim() : '';
      try {
        // Encontra TODOS os endpoints de testes atuais deste cliente
        const existingTests = await this.prisma.telephony_endpoints.findMany({
          where: {
            client_id: id,
            company_id: effectiveCompanyId,
            agent_step: 'test',
          },
        });

        // Remove quaisquer endpoints de testes anteriores que não sejam o novo (testExt + provider)
        for (const ep of existingTests) {
          if (
            !testExt ||
            ep.did_number !== testExt ||
            ep.provider !== provider
          ) {
            await this.prisma.telephony_endpoints.delete({
              where: { id: ep.id },
            });
            await this.telephonyResolver.invalidate(ep.did_number);
          }
        }

        if (testExt) {
          await this.assertDidAvailability(
            testExt,
            provider,
            effectiveCompanyId,
            id,
          );
          await this.prisma.telephony_endpoints.upsert({
            where: {
              did_number_provider: {
                did_number: testExt,
                provider,
              },
            },
            create: {
              company_id: effectiveCompanyId,
              client_id: id,
              provider,
              did_number: testExt,
              agent_step: 'test',
              label: `Ramal de Teste ${testExt} (Sandbox) - ${client.company_name || client.agent_name || 'Agente'}`,
              audio_format: codec,
              enabled: true,
            },
            update: {
              company_id: effectiveCompanyId,
              client_id: id,
              agent_step: 'test',
              label: `Ramal de Teste ${testExt} (Sandbox) - ${client.company_name || client.agent_name || 'Agente'}`,
              audio_format: codec,
              enabled: true,
              updated_at: new Date(),
            },
          });
          await this.telephonyResolver.invalidate(testExt);
        }
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `Falha ao atualizar ramal de testes ${testExt} para cliente ${id}: ${err.message}`,
        );
      }
    }

    if (client) void this.metadataService.refresh(client.id);
    return this.findOne(id, companyId, role);
  }

  async remove(id: string, companyId: string, role?: string) {
    await this.validateClientAccess(id, companyId, role);

    // Invalida cache de ramal/DID telefônico caso existam endpoints vinculados
    try {
      const endpoints = await this.prisma.telephony_endpoints.findMany({
        where: { client_id: id },
        select: { did_number: true },
      });
      for (const ep of endpoints) {
        if (ep.did_number) {
          await this.telephonyResolver.invalidate(ep.did_number);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Falha ao invalidar cache telefônico para cliente ${id}: ${err.message}`,
      );
    }

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

  async getLlmConfig(
    clientId: string,
    companyId: string,
    userId: string,
    role?: string,
  ) {
    await this.validateClientAccess(clientId, companyId, role);

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
      const legacyExtras = decryptedLegacy[cred.provider] || {};
      masked[cred.provider] = {
        hasStoredKey,
        apiKey: hasStoredKey ? this.maskApiKey(rawKey) : '',
        enabledModels: Array.isArray(cred.enabled_models)
          ? (cred.enabled_models as string[])
          : [],
        healthStatus: cred.health_status || 'unknown',
        lastTestedAt: cred.last_tested_at || null,
        lastUsedAt: cred.last_used_at || null,
        // BYO Voice: config não-secreta (vem do metadata)
        baseUrl: legacyExtras?.baseUrl || legacyExtras?.base_url || '',
        voice: legacyExtras?.voice || '',
        output_sample_rate: legacyExtras?.output_sample_rate || undefined,
        timeout_ms: legacyExtras?.timeout_ms || undefined,
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

    const effectiveCompanyId = client.company_id || companyId;

    // Registra trilha de auditoria não-bloqueante
    void this.credentialAuditService.logAction({
      companyId: effectiveCompanyId,
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
        ([providerId, config]) => {
          const normalized: Record<string, any> = {
            apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
            enabledModels: Array.isArray(config?.enabledModels)
              ? config.enabledModels.filter(
                  (model: unknown): model is string =>
                    typeof model === 'string',
                )
              : [],
          };

          // BYO Voice (tts-custom/stt-custom): preserva config não-secreta
          const baseUrl =
            (typeof config?.baseUrl === 'string' && config.baseUrl.trim()) ||
            (typeof config?.base_url === 'string' && config.base_url.trim()) ||
            '';
          if (baseUrl) normalized.baseUrl = baseUrl.trim();
          if (config?.voice) normalized.voice = String(config.voice).trim();
          const sampleRate = Number(config?.output_sample_rate);
          if (Number.isFinite(sampleRate) && sampleRate > 0) {
            normalized.output_sample_rate = sampleRate;
          }
          const timeoutMs = Number(config?.timeout_ms);
          if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            normalized.timeout_ms = timeoutMs;
          }

          return [providerId, normalized];
        },
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
    role?: string,
  ) {
    await this.validateClientAccess(clientId, companyId, role);
    const client = await this.clientsRepository.findOne(clientId);
    const metadata =
      typeof client.metadata === 'object' && client.metadata !== null
        ? { ...(client.metadata as Record<string, unknown>) }
        : {};

    const effectiveCompanyId = client.company_id || companyId;
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
              companyId: effectiveCompanyId,
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
            company_id: effectiveCompanyId,
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
          companyId: effectiveCompanyId,
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
          companyId: effectiveCompanyId,
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

  /**
   * Testa conectividade/auth/formato de um endpoint BYO de TTS ou STT.
   * TTS: sintetiza uma frase curta e valida áudio PCM/WAV na resposta.
   * STT: envia um WAV de 1s (tom 440Hz) e valida resposta com texto.
   */
  async testVoiceProvider(
    clientId: string,
    dto: TestVoiceProviderDto,
    companyId: string,
    role?: string,
  ) {
    await this.validateClientAccess(clientId, companyId, role);

    let url: URL;
    try {
      url = assertPublicHttpUrl(
        dto.baseUrl,
        dto.kind === 'tts' ? 'TTS customizado' : 'STT customizado',
      );
    } catch (err: any) {
      return { ok: false, error: err.message };
    }

    const timeoutMs = customHttpTimeout(dto.timeoutMs);
    const startMs = Date.now();

    try {
      if (dto.kind === 'tts') {
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${dto.apiKey || ''}`,
          },
          body: JSON.stringify({
            text: 'Teste de voz do Synexa.',
            voice: dto.voice || undefined,
            language: 'pt',
            format: 'pcm_s16le',
            sample_rate: dto.outputSampleRate || 24000,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = Date.now() - startMs;
        if (!res.ok) {
          return {
            ok: false,
            latencyMs,
            error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          };
        }
        const contentType = res.headers.get('content-type') || '';
        let bytes = 0;
        if (contentType.includes('application/json')) {
          const json = (await res.json()) as { audio_base64?: string };
          bytes = json.audio_base64
            ? Buffer.byteLength(json.audio_base64, 'base64')
            : 0;
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          bytes = buf.length;
        }
        if (bytes === 0) {
          return {
            ok: false,
            latencyMs,
            error:
              'Resposta sem áudio (esperado PCM bruto, WAV ou audio_base64)',
          };
        }
        return {
          ok: true,
          latencyMs,
          bytes,
          message: `TTS respondeu ${bytes} bytes de áudio em ${latencyMs}ms`,
        };
      }

      // STT: WAV mono 16kHz de 1s com tom 440Hz
      const sampleRate = 16000;
      const pcm = Buffer.alloc(sampleRate * 2);
      for (let i = 0; i < sampleRate; i++) {
        pcm.writeInt16LE(
          Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000),
          i * 2,
        );
      }
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          Authorization: `Bearer ${dto.apiKey || ''}`,
        },
        body: new Uint8Array(pcmToWav(pcm, sampleRate)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - startMs;
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        };
      }
      const raw = await res.text();
      if (raw.length > MAX_CUSTOM_RESPONSE_BYTES / 10) {
        return {
          ok: false,
          latencyMs,
          error: 'Resposta excessivamente grande',
        };
      }
      let text = raw.trim();
      try {
        const json = JSON.parse(raw) as {
          text?: string;
          transcript?: string;
          result?: string;
        };
        text = (json.text || json.transcript || json.result || '').trim();
      } catch {
        // resposta texto puro
      }
      return {
        ok: true,
        latencyMs,
        text,
        message: `STT respondeu em ${latencyMs}ms: "${text || '(sem texto para o tom de teste — normal)'}"`,
      };
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - startMs,
        error: err.message || 'Falha na conexão',
      };
    }
  }
}
