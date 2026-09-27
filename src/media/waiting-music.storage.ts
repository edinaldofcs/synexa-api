import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { LocalStorageProvider } from './providers/local-storage.provider';

@Injectable()
export class WaitingMusicStorage {
  private readonly local: LocalStorageProvider | null;
  private readonly supabase: SupabaseClient | null;
  private readonly bucketName: string;
  supportsBucket(bucket: string): boolean {
    return bucket === this.bucketName;
  }
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.bucketName = config.get<string>('MEDIA_BUCKET', 'synexa-media');
    this.local =
      config.get('ENVIRONMENT') === 'development'
        ? new LocalStorageProvider()
        : null;
    const url = config.get<string>('SUPABASE_URL');
    const key =
      config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      config.get<string>('SUPABASE_SECRET_KEY');
    this.supabase =
      url && key
        ? createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
  }
  private async ensureBucket() {
    if (this.local) {
      await this.local.ensureBucket(this.bucketName);
      return;
    }
    if (!this.supabase)
      throw new BadRequestException('Armazenamento indisponível');
    const current = await this.supabase.storage.getBucket(this.bucketName);
    if (!current.data) {
      const created = await this.supabase.storage.createBucket(
        this.bucketName,
        { public: false },
      );
      if (
        created.error &&
        !(await this.supabase.storage.getBucket(this.bucketName)).data
      )
        throw new BadRequestException('Armazenamento indisponível');
    }
  }
  /** Internal storage operations; callers must authorize the client/asset first. */
  async storeWaitingMusic(
    companyId: string,
    clientId: string,
    wav: Buffer,
    name: string,
  ) {
    await this.ensureBucket();
    const path = `${companyId}/${clientId}/${randomUUID()}.wav`;
    const options = { contentType: 'audio/wav', upsert: false };
    const result = this.local
      ? await this.local.upload(this.bucketName, path, wav, options)
      : await this.supabase!.storage.from(this.bucketName).upload(
          path,
          wav,
          options,
        );
    if (result.error)
      throw new BadRequestException('Falha ao armazenar música');
    try {
      return await this.prisma.media_assets.create({
        data: {
          company_id: companyId,
          client_id: clientId,
          storage_bucket: this.bucketName,
          storage_path: path,
          mime_type: 'audio/wav',
          file_size: wav.length,
          duration_ms: Math.round((wav.length - 44) / 48),
          status: 'ready',
          metadata: {
            purpose: 'waiting_music',
            original_name: name.slice(0, 200),
          },
        },
      });
    } catch (error) {
      if (this.local)
        await this.local.remove(this.bucketName, path).catch(() => undefined);
      else await this.supabase!.storage.from(this.bucketName).remove([path]);
      throw error;
    }
  }

  async readStoredAudio(bucket: string, path: string): Promise<Buffer> {
    if (this.local) {
      const result = await this.local.download(bucket, path);
      if (result.error || !result.data)
        throw new Error('Music storage unavailable');
      return Buffer.from(result.data);
    }
    if (!this.supabase) throw new Error('Music storage unavailable');
    const result = await this.supabase!.storage.from(bucket).download(path);
    if (result.error || !result.data)
      throw new Error('Music storage unavailable');
    return Buffer.from(await result.data.arrayBuffer());
  }
}
