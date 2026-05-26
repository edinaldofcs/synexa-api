import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const FIELD_ALIAS: Record<string, string> = {
  is_active: 'active',
};

const KNOWN_FIELDS = new Set([
  'client_id',
  'agent_id',
  'name',
  'description',
  'execution_order',
  'method',
  'url',
  'body',
  'parameters',
  'extract_data',
  'visible_to_agent',
  'active',
  'next_tool',
]);

@Injectable()
export class ApisRepository {
  constructor(private readonly prisma: PrismaService) {}

  private splitPayload(payload: Record<string, unknown>) {
    const db: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      const dbKey = FIELD_ALIAS[k] || k;
      if (KNOWN_FIELDS.has(dbKey)) db[dbKey] = v;
      else meta[k] = v;
    }
    return { ...db, headers: meta };
  }

  private flat(api: Record<string, unknown> | null) {
    if (!api) return api;
    const { headers, ...rest } = api;
    const meta =
      typeof headers === 'object' && headers !== null
        ? (headers as Record<string, unknown>)
        : {};
    const merged = { ...meta, ...rest } as Record<string, unknown>;

    for (const [alias, dbKey] of Object.entries(FIELD_ALIAS)) {
      if (dbKey in merged && !(alias in merged)) {
        merged[alias] = merged[dbKey];
      }
    }

    return merged as any;
  }

  async create(clientId: string, payload: Record<string, unknown>) {
    const api = await this.prisma.painel_apis.create({
      data: this.splitPayload({ ...payload, client_id: clientId }) as any,
    });
    return this.flat(api as any);
  }

  async findAllByClient(clientId: string) {
    const apis = await this.prisma.painel_apis.findMany({
      where: { client_id: clientId },
      orderBy: { name: 'asc' },
    });
    return apis.map((a) => this.flat(a as any));
  }

  async findOne(id: string) {
    const api = await this.prisma.painel_apis.findUnique({ where: { id } });
    if (!api) throw new NotFoundException(`API with ID ${id} not found`);
    return this.flat(api as any);
  }

  async update(id: string, payload: Record<string, unknown>) {
    const raw = await this.prisma.painel_apis.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException(`API with ID ${id} not found`);
    const existingHeaders =
      typeof raw.headers === 'object' && raw.headers !== null
        ? (raw.headers as Record<string, unknown>)
        : {};
    const dbPayload = this.splitPayload(payload);
    dbPayload.headers = {
      ...existingHeaders,
      ...dbPayload.headers,
    };
    const api = await this.prisma.painel_apis.update({
      where: { id },
      data: dbPayload as any,
    });
    return this.flat(api as any);
  }

  async remove(id: string) {
    const api = await this.findOne(id);
    await this.prisma.painel_apis.delete({ where: { id } });
    return { api, result: { success: true } };
  }

  async findAgentClientId(agentId: string) {
    const agent = await this.prisma.painel_agents.findUnique({
      where: { id: agentId },
      select: { client_id: true },
    });
    return agent?.client_id ?? null;
  }
}
