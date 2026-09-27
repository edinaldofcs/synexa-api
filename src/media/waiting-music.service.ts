import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WaitingMusicStorage } from './waiting-music.storage';
import {
  normalizeWaitingMusic,
  readWaitingMusic,
  wavToPcm,
} from './waiting-music.util';

export type MusicActor = { company_id: string; role?: string };
@Injectable()
export class WaitingMusicService {
  private converting = 0;
  private cache = new Map<string, { wav: Buffer; expires: number }>();
  private cacheBytes = 0;
  private loading = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: WaitingMusicStorage,
  ) {}

  async authorize(clientId: string, actor: MusicActor) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (
      !client ||
      (actor.role !== 'platform_admin' &&
        client.company_id !== actor.company_id)
    )
      throw new NotFoundException('Fluxo não encontrado');
    return client.company_id;
  }
  async upload(clientId: string, actor: MusicActor, file: any) {
    const companyId = await this.authorize(clientId, actor);
    if (this.converting >= 2)
      throw new ServiceUnavailableException(
        'Processamento ocupado. Tente novamente.',
      );
    this.converting++;
    try {
      const wav = await normalizeWaitingMusic(file?.buffer);
      return await this.media.storeWaitingMusic(
        companyId,
        clientId,
        wav,
        file.originalname || 'Música',
      );
    } finally {
      this.converting--;
    }
  }
  async list(clientId: string, actor: MusicActor) {
    const companyId = await this.authorize(clientId, actor);
    return this.prisma.media_assets.findMany({
      where: {
        client_id: clientId,
        company_id: companyId,
        status: 'ready',
        metadata: { path: ['purpose'], equals: 'waiting_music' },
      },
      select: { id: true, metadata: true, duration_ms: true },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }
  async asset(clientId: string, assetId: string) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(assetId))
      throw new BadRequestException('Música inválida');
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    const asset =
      client &&
      (await this.prisma.media_assets.findFirst({
        where: {
          id: assetId,
          client_id: clientId,
          company_id: client.company_id,
          status: 'ready',
          mime_type: 'audio/wav',
          metadata: { path: ['purpose'], equals: 'waiting_music' },
        },
      }));
    if (
      !asset?.storage_bucket ||
      !this.media.supportsBucket(asset.storage_bucket) ||
      !asset.storage_path ||
      !asset.storage_path.startsWith(`${client!.company_id}/${clientId}/`) ||
      !/^[a-f\d-]{36}\.wav$/i.test(
        asset.storage_path.slice(`${client!.company_id}/${clientId}/`.length),
      ) ||
      !asset.file_size ||
      Number(asset.file_size) > 8640044
    )
      throw new NotFoundException('Música indisponível neste fluxo');
    return asset;
  }
  async validateConfig(clientId: string | null, raw: any) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof raw.enabled !== 'boolean' ||
      typeof raw.volume !== 'number' ||
      !Number.isFinite(raw.volume) ||
      raw.volume < 0 ||
      raw.volume > 100 ||
      (raw.media_asset_id != null && typeof raw.media_asset_id !== 'string')
    )
      throw new BadRequestException('Configuração de música inválida');
    const config = readWaitingMusic(raw);
    if (config.enabled && !config.media_asset_id)
      throw new BadRequestException('Selecione uma música');
    if (config.media_asset_id) {
      if (!clientId)
        throw new BadRequestException(
          'Salve o fluxo antes de selecionar uma música',
        );
      await this.asset(clientId, config.media_asset_id);
    }
    return config;
  }
  async audio(clientId: string, assetId: string): Promise<Buffer> {
    // Authorization is checked even on cache hits, including deleted/disabled assets.
    const asset = await this.asset(clientId, assetId);
    const key = `${clientId}:${asset.id}:${asset.updated_at?.toISOString() || 'initial'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.wav;
    if (this.loading.has(key)) return this.loading.get(key)!;
    if (this.loading.size >= 8)
      throw new ServiceUnavailableException('Music loading busy');
    const pending = (async () => {
      const wav = await this.media.readStoredAudio(
        asset.storage_bucket!,
        asset.storage_path!,
      );
      wavToPcm(wav);
      const previous = this.cache.get(key);
      if (previous) {
        this.cache.delete(key);
        this.cacheBytes -= previous.wav.length;
      }
      while (
        this.cacheBytes + wav.length > 64 * 1024 * 1024 &&
        this.cache.size
      ) {
        const oldest = this.cache.entries().next().value!;
        this.cache.delete(oldest[0]);
        this.cacheBytes -= oldest[1].wav.length;
      }
      this.cache.set(key, { wav, expires: Date.now() + 600000 });
      this.cacheBytes += wav.length;
      return wav;
    })();
    this.loading.set(key, pending);
    try {
      return await pending;
    } finally {
      this.loading.delete(key);
    }
  }
}
