import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import type { MediaService } from '../media/media.service';
import { TelephonyEndpointResolverService } from '../voice/services/telephony-endpoint-resolver.service';
import { DuplicateClientDto } from './dto/duplicate-client.dto';

type Row = Record<string, any>;
export type DuplicationActor = {
  id: string;
  company_id: string;
  role?: string;
};
const TABLES = [
  'painel_agents',
  'painel_subagents',
  'painel_apis',
  'painel_tracks',
  'provider_credentials',
  'knowledge_bases',
  'knowledge_documents',
  'knowledge_chunks',
  'telephony_endpoints',
] as const;
type Snapshot = {
  client: Row;
  rows: Record<string, Row[]>;
  fingerprint: string;
};
const CONFIG_KEYS = new Set([
  'voice_engine',
  'gemini_live',
  'voice_behavior',
  'voice_settings',
  'tts_provider',
  'stt_provider',
  'llm_providers',
  'inbound_variable_mapping',
  'inbound_mapping',
  'interaction_mode',
  'variable_schema',
  'session_output_config',
  'flow_layout',
  'flow_studio',
  'flow_settings',
  'max_call_duration_seconds',
]);
const REFERENCE_KEYS = new Set([
  'agent_id',
  'target_agent_id',
  'next_agent_id',
  'next_api_id',
  'default_next_api_id',
  'next_tool',
  'knowledge_base_id',
  'chunk_id',
  'document_id',
  'media_asset_id',
  'allowed_subagents',
  'allowed_subagent_ids',
  'allowed_knowledge_base_ids',
]);

function assertFlowReferences(
  value: any,
  ids: Map<string, string>,
  key = '',
): void {
  if (
    typeof value === 'string' &&
    REFERENCE_KEYS.has(key) &&
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) &&
    !ids.has(value)
  ) {
    throw new ConflictException(
      'O fluxo contém uma referência externa ou inválida. Corrija o vínculo antes de duplicar',
    );
  }
  if (Array.isArray(value))
    for (const item of value) assertFlowReferences(item, ids, key);
  else if (value && typeof value === 'object' && !(value instanceof Date))
    for (const [name, item] of Object.entries(value))
      assertFlowReferences(item, ids, name);
}

/** Remap structured IDs, including JSON object keys, without rewriting prompt text. */
export function remapFlowReferences(value: any, ids: Map<string, string>): any {
  if (typeof value === 'string') return ids.get(value) || value;
  if (Array.isArray(value))
    return value.map((item) => remapFlowReferences(item, ids));
  if (!value || typeof value !== 'object' || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      ids.get(key) || key,
      remapFlowReferences(item, ids),
    ]),
  );
}

@Injectable()
export class ClientDuplicationService {
  private readonly logger = new Logger(ClientDuplicationService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject('FLOW_FILE_COPIER')
    private readonly media: Pick<
      MediaService,
      'copyFlowFile' | 'removeFlowFile'
    >,
    private readonly metadata: ClientMetadataService,
    private readonly telephony: TelephonyEndpointResolverService,
  ) {}

  private async authorize(
    db: Prisma.TransactionClient,
    clientId: string,
    actor: DuplicationActor,
  ) {
    if (
      !actor.id ||
      !['platform_admin', 'company_admin'].includes(actor.role || '') ||
      (actor.role !== 'platform_admin' && !actor.company_id)
    ) {
      throw new ForbiddenException('Sem permissão para duplicar clientes');
    }
    const client = await db.painel_clients.findFirst({
      where: {
        id: clientId,
        ...(actor.role === 'platform_admin'
          ? {}
          : { company_id: actor.company_id }),
      },
    });
    if (!client) throw new NotFoundException('Cliente não encontrado');
    return client;
  }

  async preview(clientId: string, actor: DuplicationActor) {
    const client = await this.authorize(this.prisma, clientId, actor);
    const counts = Object.fromEntries(
      await Promise.all(
        TABLES.filter((t) => t !== 'telephony_endpoints').map(async (table) => [
          table,
          await (this.prisma[table] as any).count({
            where: { client_id: clientId },
          }),
        ]),
      ),
    );
    const endpoints = await this.prisma.telephony_endpoints.findMany({
      where: { client_id: clientId, company_id: client.company_id },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        provider: true,
        did_number: true,
        label: true,
        agent_step: true,
      },
    });
    const processing = await this.prisma.knowledge_documents.count({
      where: { client_id: clientId, status: { in: ['pending', 'processing'] } },
    });
    return {
      company_name: this.copyName(client.company_name || client.agent_name),
      counts,
      endpoints,
      processing_documents: processing,
    };
  }

  private copyName(name: unknown) {
    return `${String(name || 'Fluxo').slice(0, 247)} (Cópia)`;
  }

  private async snapshot(
    db: Prisma.TransactionClient,
    clientId: string,
    actor: DuplicationActor,
  ): Promise<Snapshot> {
    const client = await this.authorize(db, clientId, actor);
    const rows: Record<string, Row[]> = {};
    for (const table of TABLES) {
      rows[table] = await (db[table] as any).findMany({
        where: { client_id: clientId },
        orderBy: { id: 'asc' },
      });
      if (
        rows[table].some(
          (row) => row.company_id && row.company_id !== client.company_id,
        )
      )
        throw new ConflictException('Vínculo inválido no fluxo original');
    }
    if (
      rows.knowledge_documents.some((doc) =>
        ['pending', 'processing'].includes(doc.status),
      )
    ) {
      throw new ConflictException(
        'Aguarde o processamento dos documentos antes de duplicar o fluxo',
      );
    }
    const assetIds = [
      ...new Set(
        rows.knowledge_documents
          .map((doc) => doc.media_asset_id)
          .filter(Boolean),
      ),
    ];
    rows.media_assets = assetIds.length
      ? await db.media_assets.findMany({
          where: { id: { in: assetIds }, company_id: client.company_id },
          orderBy: { id: 'asc' },
        })
      : [];
    if (rows.media_assets.length !== assetIds.length)
      throw new ConflictException(
        'Arquivo da base de conhecimento indisponível',
      );
    rows.knowledge_embeddings = await db.knowledge_embeddings.findMany({
      where: { client_id: clientId, company_id: client.company_id },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        chunk_id: true,
        knowledge_base_id: true,
        metadata: true,
      },
    });
    // Live calls update credential usage; only configuration changes invalidate a copy.
    const stableRows = Object.fromEntries(
      Object.entries(rows).map(([table, entries]) => [
        table,
        entries.map((row) => {
          const stable = { ...row };
          delete stable.created_at;
          delete stable.updated_at;
          if (table === 'provider_credentials') {
            delete stable.last_used_at;
            delete stable.last_tested_at;
            delete stable.health_status;
          }
          return stable;
        }),
      ]),
    );
    const stableClient = {
      ...client,
      metadata: Object.fromEntries(
        Object.entries(client.metadata || {}).filter(([key]) =>
          CONFIG_KEYS.has(key),
        ),
      ),
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ client: stableClient, rows: stableRows }))
      .digest('hex');
    return { client, rows, fingerprint };
  }

  private async validateEndpoints(
    db: Prisma.TransactionClient,
    snapshot: Snapshot,
    dto: DuplicateClientDto,
  ) {
    const source = snapshot.rows.telephony_endpoints;
    if (dto.endpoints === undefined) return [];
    if (!Array.isArray(dto.endpoints))
      throw new BadRequestException('Endpoints inválidos');
    const supplied = dto.endpoints;
    if (
      supplied.length !== source.length ||
      new Set(supplied.map((e) => e.source_endpoint_id)).size !==
        supplied.length
    ) {
      throw new BadRequestException(
        'Informe um novo número para cada endpoint do fluxo',
      );
    }
    const seen = new Set<string>();
    const selected: Row[] = [];
    for (const replacement of supplied) {
      const endpoint = source.find(
        (e) => e.id === replacement.source_endpoint_id,
      );
      if (!endpoint)
        throw new BadRequestException(
          'Endpoint não pertence ao fluxo original',
        );
      const number = replacement.did_number.trim();
      if (
        !number ||
        number.length > 50 ||
        [...number].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      )
        throw new BadRequestException('Número de telefonia inválido');
      const key = JSON.stringify([number, endpoint.provider]);
      // Raw SQL checks the global unique key even when Prisma tenant scoping is active.
      const existing = await db.$queryRaw<Row[]>(
        Prisma.sql`SELECT id FROM telephony_endpoints WHERE did_number = ${number} AND provider = ${endpoint.provider} LIMIT 1`,
      );
      if (seen.has(key) || existing.length) this.endpointConflict(endpoint.id);
      seen.add(key);
      selected.push({ ...endpoint, did_number: number });
    }
    return selected;
  }

  private endpointConflict(id?: string): never {
    throw new ConflictException({
      message: 'Ramal/número já está em uso para este provedor',
      code: 'DUPLICATE_ENDPOINT_CONFLICT',
      source_endpoint_id: id,
    });
  }

  private copyRow(
    table: string,
    row: Row,
    ids: Map<string, string>,
    clientId: string,
    companyId: string,
  ): Row {
    const data = remapFlowReferences(row, ids);
    data.id = ids.get(row.id);
    data.client_id = clientId;
    if ('company_id' in data) data.company_id = companyId;
    delete data.created_at;
    delete data.updated_at;
    // Prisma JSON nulls must use DbNull when writing nullable JSON columns.
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === table)!;
    for (const field of model.fields)
      if (field.type === 'Json' && data[field.name] === null)
        data[field.name] = Prisma.DbNull;
    return data;
  }

  async duplicate(
    clientId: string,
    dto: DuplicateClientDto,
    actor: DuplicationActor,
  ) {
    const started = Date.now();
    const snapshot = await this.prisma.$transaction(
      (tx) => this.snapshot(tx, clientId, actor),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30000,
      },
    );
    await this.validateEndpoints(this.prisma, snapshot, dto);
    const newId = randomUUID();
    const companyId = snapshot.client.company_id as string;
    const ids = new Map<string, string>([[clientId, newId]]);
    for (const rows of Object.values(snapshot.rows))
      for (const row of rows) ids.set(row.id, randomUUID());
    for (const rows of Object.values(snapshot.rows))
      for (const row of rows) assertFlowReferences(row, ids);
    const files: { bucket: string; path: string }[] = [];
    const assetPaths = new Map<string, string>();
    let committed = false;
    let insertingEndpoint: string | undefined;
    try {
      for (const asset of snapshot.rows.media_assets) {
        if (!asset.storage_bucket || !asset.storage_path) {
          // Remote/text documents have no locally owned binary to copy.
          if (asset.storage_bucket || asset.storage_path)
            throw new ConflictException(
              'Arquivo incompleto na base de conhecimento',
            );
          continue;
        }
        const extension = extname(asset.storage_path)
          .replace(/[^.a-zA-Z0-9]/g, '')
          .slice(0, 12);
        const path = `${companyId}/${newId}/${ids.get(asset.id)}${extension}`;
        files.push({ bucket: asset.storage_bucket, path });
        await this.media.copyFlowFile(
          asset.storage_bucket,
          asset.storage_path,
          path,
        );
        assetPaths.set(asset.id, path);
      }
      const result = await this.prisma.$transaction(
        async (tx) => {
          const current = await this.snapshot(tx, clientId, actor);
          if (current.fingerprint !== snapshot.fingerprint)
            throw new ConflictException(
              'O fluxo foi alterado durante a cópia. Tente novamente',
            );
          const endpoints = await this.validateEndpoints(tx, current, dto);
          const client: Row = {
            ...snapshot.client,
            id: newId,
            company_id: companyId,
            company_name:
              dto.company_name ||
              this.copyName(
                snapshot.client.company_name || snapshot.client.agent_name,
              ),
          };
          client.metadata = remapFlowReferences(
            Object.fromEntries(
              Object.entries(snapshot.client.metadata || {}).filter(([key]) =>
                CONFIG_KEYS.has(key),
              ),
            ),
            ids,
          );
          const testEndpoint = endpoints.find((e) => e.agent_step === 'test');
          if (testEndpoint)
            client.metadata.test_sip_extension = testEndpoint.did_number;
          await tx.painel_clients.create({ data: client as any });

          for (const table of [
            'painel_agents',
            'painel_subagents',
            'painel_apis',
            'painel_tracks',
            'provider_credentials',
            'knowledge_bases',
            'media_assets',
            'knowledge_documents',
            'knowledge_chunks',
          ]) {
            const data = snapshot.rows[table].map((row) => {
              const copy = this.copyRow(table, row, ids, newId, companyId);
              if (table === 'provider_credentials')
                Object.assign(copy, {
                  created_by: actor.id,
                  last_used_at: null,
                  last_tested_at: null,
                  health_status: 'unknown',
                });
              if (table === 'media_assets')
                Object.assign(copy, {
                  message_id: null,
                  ...(assetPaths.has(row.id)
                    ? { storage_path: assetPaths.get(row.id), source_url: null }
                    : {}),
                });
              if (table === 'knowledge_documents') {
                copy.error_message = null;
                if (
                  assetPaths.has(row.media_asset_id) &&
                  row.source_type === 'upload'
                )
                  copy.source_url = null;
              }
              return copy;
            });
            for (let i = 0; i < data.length; i += 100)
              await (tx as any)[table].createMany({
                data: data.slice(i, i + 100),
              });
          }
          // Vector is unsupported in Prisma's normal create API. Copy it server-side.
          const embeddings = snapshot.rows.knowledge_embeddings;
          for (let i = 0; i < embeddings.length; i += 100) {
            const mappings = embeddings
              .slice(i, i + 100)
              .map(
                (e) =>
                  Prisma.sql`(${e.id}::uuid, ${ids.get(e.id)}::uuid, ${ids.get(e.chunk_id)}::uuid, ${ids.get(e.knowledge_base_id)}::uuid, ${JSON.stringify(remapFlowReferences(e.metadata, ids))}::jsonb)`,
              );
            await tx.$executeRaw(Prisma.sql`INSERT INTO knowledge_embeddings
            (id, company_id, client_id, knowledge_base_id, chunk_id, provider, model, dimensions, embedding, metadata)
            SELECT m.new_id, ${companyId}::uuid, ${newId}::uuid, m.base_id, m.chunk_id, e.provider, e.model, e.dimensions, e.embedding, m.metadata
            FROM knowledge_embeddings e JOIN (VALUES ${Prisma.join(mappings)}) AS m(old_id, new_id, chunk_id, base_id, metadata) ON e.id = m.old_id
            WHERE e.client_id = ${clientId}::uuid AND e.company_id = ${companyId}::uuid`);
          }
          for (const endpoint of endpoints) {
            insertingEndpoint = endpoint.id;
            const data = this.copyRow(
              'telephony_endpoints',
              endpoint,
              ids,
              newId,
              companyId,
            );
            data.created_by = actor.id;
            if (endpoint.inbound_secret_hash)
              data.inbound_secret_hash = createHash('sha256')
                .update(randomBytes(32))
                .digest('hex');
            await tx.telephony_endpoints.create({ data: data as any });
          }
          insertingEndpoint = undefined;
          await tx.credential_audit_logs.create({
            data: {
              company_id: companyId,
              client_id: newId,
              user_id: actor.id,
              provider: 'all',
              action: 'created',
              metadata: {
                operation: 'flow_duplicated',
                source_client_id: clientId,
              },
            },
          });
          // Explicit public projection: metadata may contain provider credentials.
          return {
            id: newId,
            company_id: companyId,
            company_name: client.company_name,
            agent_name: client.agent_name,
            logo_url: client.logo_url,
            logo_icon: client.logo_icon,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 60000,
        },
      );
      committed = true;
      try {
        await this.metadata.refresh(newId);
      } catch {
        this.logger.error({
          event: 'flow_copy_metadata_refresh_failed',
          clientId: newId,
        });
      }
      for (const endpoint of dto.endpoints || []) {
        try {
          await this.telephony.invalidate(endpoint.did_number);
        } catch {
          this.logger.warn({
            event: 'flow_copy_cache_invalidation_failed',
            clientId: newId,
          });
        }
      }
      this.logger.log({
        event: 'flow_duplicated',
        sourceClientId: clientId,
        clientId: newId,
        companyId,
        userId: actor.id,
        durationMs: Date.now() - started,
        counts: Object.fromEntries(
          Object.entries(snapshot.rows).map(([key, rows]) => [
            key,
            rows.length,
          ]),
        ),
      });
      return result;
    } catch (error: any) {
      if (!committed)
        for (const file of files) {
          try {
            await this.media.removeFlowFile(file.bucket, file.path);
          } catch {
            this.logger.error({
              event: 'flow_copy_file_cleanup_failed',
              clientId: newId,
              ...file,
            });
          }
        }
      this.logger.warn({
        event: 'flow_duplication_failed',
        sourceClientId: clientId,
        clientId: newId,
        userId: actor.id,
        code: error?.code || error?.getStatus?.() || 'internal',
      });
      if (error?.code === 'P2002' && insertingEndpoint)
        this.endpointConflict(insertingEndpoint);
      if (error?.code === 'P2034')
        throw new ConflictException(
          'O fluxo foi alterado durante a cópia. Tente novamente',
        );
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new InternalServerErrorException(
        'Não foi possível duplicar o fluxo. Tente novamente',
      );
    }
  }
}
