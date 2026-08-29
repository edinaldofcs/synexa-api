import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

const ROUTE_CACHE_TTL_SECONDS = 60;

export interface TelephonyRouteLookup {
  /** DID / número discado (ex: agi_extension, dnid ou origem da chamada) */
  didNumber?: string;
  /** Identificador do ingresso de transporte (ex: asterisk_fastagi, audiosocket, callflex_ws) */
  providerName?: string;
  /**
   * Dica legada enviada pelo dialplan/discador via variáveis SYNEXA_*.
   * Tem precedência sobre o roteamento por DID para manter compatibilidade.
   */
  clientIdHint?: string;
  /** Sobrescreve o agent_step configurado no endpoint (SYNEXA_AGENT_STEP) */
  agentStepHint?: string;
}

export interface ResolvedTelephonyRoute {
  endpointId: string | null;
  provider: string;
  didNumber: string | null;
  audioFormat: string;
  agent_step?: string | null;
  company_id: string;
  client_id: string;
  client: Record<string, unknown>;
  agent: Record<string, unknown> | null;
}

/**
 * Resolve qual empresa/cliente/agente atende uma chamada de voz.
 *
 * Roteamento plug-and-play: cada linha em `telephony_endpoints` mapeia um
 * DID/provedor para um tenant. Substitui o antigo `findFirst()` global que
 * cruzava tenants quando o discador não enviava SYNEXA_CLIENT_ID.
 */
@Injectable()
export class TelephonyEndpointResolverService {
  private readonly logger = new Logger(TelephonyEndpointResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  public async resolve(
    lookup: TelephonyRouteLookup,
  ): Promise<ResolvedTelephonyRoute | null> {
    const cacheKey = this.cacheKey(lookup);

    if (cacheKey) {
      try {
        const cached = await this.redis.get<ResolvedTelephonyRoute>(cacheKey);
        if (cached?.company_id && cached.client?.id) {
          return cached;
        }
      } catch {
        // Cache indisponível: segue com consulta ao banco
      }
    }

    const resolved = await this.resolveFromDatabase(lookup);
    if (resolved && cacheKey) {
      try {
        await this.redis.set(cacheKey, resolved, ROUTE_CACHE_TTL_SECONDS);
      } catch {
        // Sem cache: segue o fluxo
      }
    }
    return resolved;
  }

  /**
   * Ingressos autenticados por secret (WS de discador): resolve a rota
   * direto pelo hash do token, opcionalmente filtrando pelo DID informado
   * no frame de identificação.
   */
  public async resolveBySecretHash(
    tokenHash: string,
    didNumber?: string,
  ): Promise<ResolvedTelephonyRoute | null> {
    const candidates = await this.prisma.telephony_endpoints.findMany({
      where: { inbound_secret_hash: tokenHash, enabled: true },
      orderBy: { created_at: 'asc' },
    });

    if (!candidates.length) return null;

    const selected = didNumber
      ? (candidates.find((c) => c.did_number === didNumber) ?? candidates[0])
      : candidates[0];

    if (!selected?.client_id) return null;

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: selected.client_id },
    });
    if (!client?.company_id) return null;

    const agent = await this.resolveAgent(
      selected.client_id,
      didNumber && selected.agent_step ? selected.agent_step : undefined,
    );

    return {
      endpointId: selected.id,
      provider: selected.provider,
      didNumber: selected.did_number,
      audioFormat: selected.audio_format || 'g711_ulaw',
      agent_step: selected.agent_step ?? null,
      company_id: client.company_id,
      client_id: selected.client_id,
      client: client as unknown as Record<string, unknown>,
      agent,
    };
  }

  /**
   * Invalida a rota em cache após alterações nos endpoints (CRUD admin).
   * Rotas por SYNEXA_CLIENT_ID expiram naturalmente (TTL curto).
   */
  public async invalidate(didNumber?: string): Promise<void> {
    if (!didNumber) return;
    try {
      await this.redis.del(`voice:endpoint:${didNumber}`);
    } catch {
      // Cache indisponível: nada a invalidar
    }
  }

  private async resolveFromDatabase(
    lookup: TelephonyRouteLookup,
  ): Promise<ResolvedTelephonyRoute | null> {
    let clientId = lookup.clientIdHint || undefined;
    let companyId: string | undefined;
    let endpointId: string | null = null;
    let endpointAgentStep: string | null = null;
    let provider = 'legacy_variables';
    let didNumber: string | null = null;
    let audioFormat = 'g711_ulaw';

    if (!clientId && !lookup.didNumber) return null;

    if (lookup.didNumber) {
      const endpoint = await this.findEndpoint(lookup).catch((err: Error) => {
        this.logger.warn(
          `[EndpointResolver] Falha ao consultar telephony_endpoints (${err.message}); rode a migration 20260827010000_add_telephony_endpoints.`,
        );
        return null;
      });

      if (endpoint) {
        endpointId = endpoint.id;
        endpointAgentStep = endpoint.agent_step || null;
        provider = endpoint.provider;
        didNumber = endpoint.did_number;
        audioFormat = endpoint.audio_format || 'g711_ulaw';
        companyId = endpoint.company_id;
        clientId = clientId || endpoint.client_id || undefined;
      }
    }

    if (!clientId) {
      // Sem endpoint ligado a nenhum cliente: recusa (anti cross-tenant).
      return null;
    }

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
    });
    if (!client?.company_id) return null;

    const agentStep = lookup.agentStepHint || endpointAgentStep || undefined;
    const agent = await this.resolveAgent(client.id, agentStep);

    return {
      endpointId,
      provider,
      didNumber,
      audioFormat,
      agent_step: agentStep ?? null,
      company_id: companyId || client.company_id,
      client_id: client.id,
      client: client as unknown as Record<string, unknown>,
      agent: agent as unknown as Record<string, unknown> | null,
    };
  }

  private async findEndpoint(lookup: TelephonyRouteLookup) {
    // 1. Match exato DID + provedor do ingresso
    const exact = await this.prisma.telephony_endpoints.findFirst({
      where: {
        did_number: lookup.didNumber!,
        ...(lookup.providerName ? { provider: lookup.providerName } : {}),
        enabled: true,
      },
    });
    if (exact) return exact;

    // 2. Mesmo DID em qualquer provedor habilitado (trunk genérico)
    return this.prisma.telephony_endpoints.findFirst({
      where: {
        did_number: lookup.didNumber!,
        enabled: true,
      },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Carrega o agente alvo respeitando step configurado ou o padrão inicial ativo.
   * Prioridade:
   * 1. Match por service_step (se informado)
   * 2. Agente marcado com is_initial: true e interaction_mode != 'text'
   * 3. Agente marcado com is_initial: true
   * 4. Primeiro agente ativo para voz por execution_order ASC
   * 5. Primeiro agente ativo geral por execution_order ASC
   */
  private async resolveAgent(
    clientId: string,
    agentStep?: string,
  ): Promise<Record<string, unknown> | null> {
    if (agentStep) {
      const stepAgent = await this.prisma.painel_agents.findFirst({
        where: {
          client_id: clientId,
          service_step: agentStep,
          is_active: true,
        },
      });
      if (stepAgent) return stepAgent as unknown as Record<string, unknown>;
    }

    // 1. Agente inicial de voz/ambos
    const initialVoiceAgent = await this.prisma.painel_agents.findFirst({
      where: {
        client_id: clientId,
        is_active: true,
        is_initial: true,
        interaction_mode: { not: 'text' },
      },
      orderBy: { execution_order: 'asc' },
    });
    if (initialVoiceAgent) {
      return initialVoiceAgent as unknown as Record<string, unknown>;
    }

    // 2. Agente inicial geral
    const initialAgent = await this.prisma.painel_agents.findFirst({
      where: {
        client_id: clientId,
        is_active: true,
        is_initial: true,
      },
      orderBy: { execution_order: 'asc' },
    });
    if (initialAgent) {
      return initialAgent as unknown as Record<string, unknown>;
    }

    // 3. Primeiro agente ativo de voz ordenado por execution_order
    const firstVoiceAgent = await this.prisma.painel_agents.findFirst({
      where: {
        client_id: clientId,
        is_active: true,
        interaction_mode: { not: 'text' },
      },
      orderBy: { execution_order: 'asc' },
    });
    if (firstVoiceAgent) {
      return firstVoiceAgent as unknown as Record<string, unknown>;
    }

    // 4. Primeiro agente ativo geral
    const firstAgent = await this.prisma.painel_agents.findFirst({
      where: {
        client_id: clientId,
        is_active: true,
      },
      orderBy: { execution_order: 'asc' },
    });
    return firstAgent as unknown as Record<string, unknown> | null;
  }

  private cacheKey(lookup: TelephonyRouteLookup): string | null {
    if (lookup.didNumber) return `voice:endpoint:${lookup.didNumber}`;
    if (lookup.clientIdHint) {
      return `voice:endpoint_by_client:${lookup.clientIdHint}`;
    }
    return null;
  }
}
