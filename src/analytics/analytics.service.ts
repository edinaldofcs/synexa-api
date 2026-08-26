import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  ActivationConditionGroup,
} from '../orchestrator/utils/condition-evaluator.util';
import type {
  AnalyticsConfigPayload,
  BusinessMarkerDto,
} from './dto/analytics.dto';

interface EvaluateParams {
  clientId: string;
  companyId: string;
  conversationId?: string;
  endUserId?: string | null;
  originChannel?: string | null;
  /** Nomes das ferramentas executadas neste turno (se houver) */
  toolNames?: string[];
  toolOk?: boolean;
  /** Estado da sessão enriquecido com o retorno das ferramentas */
  state: Record<string, unknown>;
}

const ANALYTICS_CONFIG_KEY = 'analytics_config';
/** Cache curto da config por cliente para evitar leitura de metadata a cada turno */
const CONFIG_CACHE_TTL_MS = 30_000;

export interface MarkerTotal {
  code: string;
  label: string;
  count: number;
  sums: Record<string, number>;
  lastAt: string | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private configCache = new Map<
    string,
    { config: AnalyticsConfigPayload; loadedAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  // ── Configuração ────────────────────────────────────────────────

  async getConfig(clientId: string): Promise<AnalyticsConfigPayload> {
    const cached = this.configCache.get(clientId);
    if (cached && Date.now() - cached.loadedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });
    const meta = (client?.metadata as Record<string, unknown>) || {};
    const config = (meta[ANALYTICS_CONFIG_KEY] as AnalyticsConfigPayload) || {
      markers: [],
      funnel: [],
    };

    const normalized: AnalyticsConfigPayload = {
      markers: Array.isArray(config.markers) ? config.markers : [],
      funnel: Array.isArray(config.funnel) ? config.funnel : [],
    };
    this.configCache.set(clientId, {
      config: normalized,
      loadedAt: Date.now(),
    });
    return normalized;
  }

  async saveConfig(
    clientId: string,
    companyId: string,
    config: AnalyticsConfigPayload,
  ): Promise<AnalyticsConfigPayload> {
    const client = await this.prisma.painel_clients.findFirst({
      where: { id: clientId, company_id: companyId },
      select: { metadata: true },
    });
    if (!client) throw new Error('Cliente não encontrado');

    const meta =
      ((client.metadata as Record<string, unknown>) || {}) as Record<string, unknown>;
    const normalized: AnalyticsConfigPayload = {
      markers: config.markers ?? [],
      funnel: (config.funnel ?? []).filter((code) =>
        (config.markers ?? []).some((m) => m.code === code),
      ),
    };

    await this.prisma.painel_clients.update({
      where: { id: clientId },
      data: {
        metadata: { ...meta, [ANALYTICS_CONFIG_KEY]: normalized } as any,
      },
    });

    this.configCache.set(clientId, {
      config: normalized,
      loadedAt: Date.now(),
    });
    return normalized;
  }

  invalidateConfigCache(clientId?: string) {
    if (clientId) this.configCache.delete(clientId);
    else this.configCache.clear();
  }

  // ── Avaliação e registro de eventos ─────────────────────────────

  /**
   * Avalia os marcadores do cliente sobre o estado pós-tool da conversa.
   * Nunca lança — falhas são logadas e ignoradas para não afetar o atendimento.
   */
  async evaluateAndRecord(params: EvaluateParams): Promise<void> {
    try {
      const { markers } = await this.getConfig(params.clientId);
      if (!markers.length) return;

      for (const marker of markers) {
        try {
          await this.evaluateMarker(marker, params);
        } catch (markerErr) {
          this.logger.warn(
            `Erro ao avaliar marcador "${marker.code}": ${(markerErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Analytics: falha ao carregar configuração: ${(err as Error).message}`,
      );
    }
  }

  private async evaluateMarker(
    marker: BusinessMarkerDto,
    params: EvaluateParams,
  ) {
    // Gatilho por ferramenta
    if (marker.trigger?.tool) {
      if (!params.toolNames?.length) return;
      if (!params.toolNames.includes(marker.trigger.tool)) return;
      if (params.toolOk === false) return;
    }

    // Condições sobre o estado da sessão
    if (marker.conditions?.length) {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: marker.conditions as ActivationConditionGroup['conditions'],
      };
      const evaluation = evaluateConditionsWithDetails(group, params.state);
      if (!evaluation.matched) {
        this.logger.debug(
          `Marcador "${marker.code}" não disparou: ${describeEvaluation(evaluation)}`,
        );
        return;
      }
    }

    if (!marker.trigger?.tool && !marker.conditions?.length) return;

    // Captura de variáveis
    const values: Record<string, unknown> = {};
    for (const key of marker.capture || []) {
      const value = params.state[key];
      if (value !== undefined && value !== null && typeof value !== 'object') {
        values[key] = value;
      }
    }

    // Upset idempotente: um evento por conversa/marcador
    if (params.conversationId) {
      const existing = await this.prisma.business_events.findFirst({
        where: {
          conversation_id: params.conversationId,
          marker_code: marker.code,
        },
        select: { id: true },
      });
      if (existing) return;
    }

    await this.prisma.business_events.create({
      data: {
        company_id: params.companyId,
        client_id: params.clientId,
        conversation_id: params.conversationId || null,
        end_user_id: params.endUserId || null,
        marker_code: marker.code,
        values: values as any,
        origin_channel: params.originChannel || null,
      },
    });
    this.logger.log(
      `📊 Marcador de negócio registrado: ${marker.code} (conversa ${params.conversationId})`,
    );
  }

  // ── Agregação analítica ─────────────────────────────────────────

  async getBusinessAnalytics(
    companyId: string,
    opts: {
      from?: Date;
      to?: Date;
      clientId?: string;
      channel?: string;
    } = {},
  ) {
    const where: Record<string, unknown> = { company_id: companyId };
    if (opts.clientId) where.client_id = opts.clientId;
    if (opts.channel) where.origin_channel = opts.channel;
    if (opts.from || opts.to) {
      where.created_at = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }

    const [events, config] = await Promise.all([
      this.prisma.business_events.findMany({
        where: where as any,
        orderBy: { created_at: 'desc' },
        take: 20000,
        include: {
          end_users: { select: { name: true } },
          conversations: { select: { origin_channel: true } },
        },
      }),
      opts.clientId ? this.getConfig(opts.clientId) : Promise.resolve(null),
    ]);

    const labels = new Map<string, string>();
    const sumFields = new Map<string, Set<string>>();
    for (const marker of config?.markers ?? []) {
      labels.set(marker.code, marker.label || marker.code);
      sumFields.set(marker.code, new Set(marker.capture || []));
    }

    const totals = new Map<string, MarkerTotal>();
    const daily = new Map<
      string,
      { date: string; counts: Record<string, number> }
    >();

    for (const event of events) {
      const total =
        totals.get(event.marker_code) ||
        ({
          code: event.marker_code,
          label: labels.get(event.marker_code) || event.marker_code,
          count: 0,
          sums: {},
          lastAt: null,
        } satisfies MarkerTotal);

      total.count += 1;
      const values = (event.values as Record<string, unknown>) || {};
      for (const key of sumFields.get(event.marker_code) || []) {
        const num = Number(values[key]);
        if (Number.isFinite(num)) {
          total.sums[key] = (total.sums[key] || 0) + num;
        }
      }
      const createdAt = event.created_at
        ? new Date(event.created_at).toISOString()
        : null;
      if (
        createdAt &&
        (!total.lastAt || createdAt > total.lastAt)
      ) {
        total.lastAt = createdAt;
      }
      totals.set(event.marker_code, total);

      if (createdAt) {
        const day = createdAt.slice(0, 10);
        const dayEntry =
          daily.get(day) || { date: day, counts: {} as Record<string, number> };
        dayEntry.counts[event.marker_code] =
          (dayEntry.counts[event.marker_code] || 0) + 1;
        daily.set(day, dayEntry);
      }
    }

    // Funil na ordem configurada do cliente (quando client_id informado)
    let funnel: Array<{
      code: string;
      label: string;
      count: number;
      conversionFromPrevious: number | null;
    }> | null = null;
    if (config && config.funnel.length) {
      funnel = config.funnel.map((code, index) => {
        const total = totals.get(code);
        const count = total?.count || 0;
        let conversionFromPrevious: number | null = null;
        if (index > 0) {
          const previousCount = totals.get(config.funnel[index - 1])?.count || 0;
          conversionFromPrevious =
            previousCount > 0 ? Math.round((count / previousCount) * 100) : null;
        }
        return {
          code,
          label: labels.get(code) || code,
          count,
          conversionFromPrevious,
        };
      });
    }

    const detailedEvents = events.slice(0, 200).map((event) => ({
      id: event.id,
      markerCode: event.marker_code,
      markerLabel: labels.get(event.marker_code) || event.marker_code,
      conversationId: event.conversation_id,
      endUserName: event.end_users?.name || null,
      channel: event.conversations?.origin_channel || event.origin_channel,
      values: (event.values as Record<string, unknown>) || {},
      createdAt: event.created_at
        ? new Date(event.created_at).toISOString()
        : null,
    }));

    return {
      period: { from: opts.from?.toISOString() || null, to: opts.to?.toISOString() || null },
      totals: [...totals.values()],
      funnel,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      events: detailedEvents,
    };
  }
}
