import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateMediaAssetDto } from './dto/create-media-asset.dto';
import { UpdateMediaAssetDto } from './dto/update-media-asset.dto';
import { UploadMediaAssetDto } from './dto/upload-media-asset.dto';

const DEFAULT_ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
];

@Injectable()
export class MediaService {
  private readonly maxFileSizeBytes = Number(process.env.MEDIA_MAX_FILE_SIZE_BYTES || 25 * 1024 * 1024);
  private readonly bucketName = process.env.MEDIA_BUCKET || 'synexa-media';
  private readonly supabase: SupabaseClient | null;
  private bucketReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY;

    this.supabase = supabaseUrl && serviceRoleKey
      ? createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;
  }

  async createAsset(clientId: string, dto: CreateMediaAssetDto, userId: string) {
    const companyId = await this.getAuthorizedCompanyId(clientId, userId);
    this.validateMimeType(dto.mime_type);
    this.validateFileSize(dto.file_size);

    if (dto.message_id) {
      await this.validateMessageAccess(dto.message_id, companyId, clientId);
    }

    const asset = await this.prisma.media_assets.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        message_id: dto.message_id || null,
        storage_bucket: dto.storage_bucket || null,
        storage_path: dto.storage_path || null,
        source_url: dto.source_url || null,
        mime_type: dto.mime_type,
        file_size: dto.file_size || null,
        checksum: dto.checksum || null,
        duration_ms: dto.duration_ms || null,
        width: dto.width || null,
        height: dto.height || null,
        status: dto.storage_path ? 'stored' : 'pending',
        metadata: (dto.metadata || {}) as any,
      },
    });

    await this.enqueueProcessingIfNeeded(asset.id, asset.mime_type);
    return asset;
  }

  async findAllByClient(clientId: string, userId: string) {
    await this.getAuthorizedCompanyId(clientId, userId);
    return this.prisma.media_assets.findMany({
      where: { client_id: clientId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async findOne(assetId: string, userId: string) {
    const asset = await this.prisma.media_assets.findUnique({
      where: { id: assetId },
    });
    if (!asset) throw new NotFoundException('Media asset not found');

    await this.getAuthorizedCompanyId(asset.client_id, userId);
    return asset;
  }

  async uploadAsset(clientId: string, file: any, dto: UploadMediaAssetDto, userId: string) {
    if (!file?.buffer) throw new BadRequestException('File is required');
    this.ensureSupabaseConfigured();

    const companyId = await this.getAuthorizedCompanyId(clientId, userId);
    this.validateMimeType(file.mimetype);
    this.validateFileSize(file.size);

    if (dto.message_id) {
      await this.validateMessageAccess(dto.message_id, companyId, clientId);
    }

    await this.ensureBucket();

    const storagePath = this.buildStoragePath(companyId, clientId, file.originalname);
    const { error } = await this.supabase!.storage
      .from(this.bucketName)
      .upload(storagePath, file.buffer, {
        cacheControl: '3600',
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const asset = await this.prisma.media_assets.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        message_id: dto.message_id || null,
        storage_bucket: this.bucketName,
        storage_path: storagePath,
        mime_type: file.mimetype,
        file_size: file.size || null,
        status: 'stored',
        metadata: {
          ...(dto.metadata || {}),
          original_name: file.originalname,
        } as any,
      },
    });

    await this.enqueueProcessingIfNeeded(asset.id, asset.mime_type);
    return asset;
  }

  async createSignedUrl(assetId: string, userId: string, expiresInSeconds = 300) {
    this.ensureSupabaseConfigured();
    const asset = await this.findOne(assetId, userId);
    if (!asset.storage_bucket || !asset.storage_path) {
      throw new BadRequestException('Media asset has no stored file');
    }

    const { data, error } = await this.supabase!.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, expiresInSeconds);

    if (error) throw new BadRequestException(`Signed URL failed: ${error.message}`);

    return {
      asset_id: asset.id,
      signed_url: data.signedUrl,
      expires_in: expiresInSeconds,
    };
  }

  async update(assetId: string, dto: UpdateMediaAssetDto, userId: string) {
    const asset = await this.findOne(assetId, userId);

    return this.prisma.media_assets.update({
      where: { id: asset.id },
      data: {
        status: dto.status,
        storage_bucket: dto.storage_bucket,
        storage_path: dto.storage_path,
        transcript: dto.transcript,
        ocr_text: dto.ocr_text,
        error_message: dto.error_message,
        metadata: dto.metadata as any,
      },
    });
  }

  private async getAuthorizedCompanyId(clientId: string, userId: string): Promise<string> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) throw new ForbiddenException('User has no company');

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== user.company_id) {
      throw new NotFoundException('Client not found');
    }

    return user.company_id;
  }

  private async validateMessageAccess(messageId: string, companyId: string, clientId: string) {
    const message = await this.prisma.messages.findUnique({
      where: { id: messageId },
      select: {
        company_id: true,
        conversations: { select: { client_id: true } },
      },
    });

    if (!message || message.company_id !== companyId || message.conversations.client_id !== clientId) {
      throw new NotFoundException('Message not found');
    }
  }

  private validateMimeType(mimeType: string) {
    const isAllowed =
      DEFAULT_ALLOWED_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix)) ||
      DEFAULT_ALLOWED_MIME_TYPES.includes(mimeType);

    if (!isAllowed) {
      throw new BadRequestException(`Unsupported media type: ${mimeType}`);
    }
  }

  private validateFileSize(fileSize?: number) {
    if (fileSize && fileSize > this.maxFileSizeBytes) {
      throw new BadRequestException(`File exceeds max size of ${this.maxFileSizeBytes} bytes`);
    }
  }

  private ensureSupabaseConfigured() {
    if (!this.supabase) {
      throw new BadRequestException('Supabase storage is not configured');
    }
  }

  private async ensureBucket() {
    if (this.bucketReady) return;

    const existing = await this.supabase!.storage.getBucket(this.bucketName);
    if (!existing.error) {
      this.bucketReady = true;
      return;
    }

    const { error } = await this.supabase!.storage.createBucket(this.bucketName, {
      public: false,
      allowedMimeTypes: [
        'image/*',
        'audio/*',
        'video/*',
        'application/pdf',
        'text/plain',
        'text/csv',
        'application/json',
      ],
      fileSizeLimit: this.maxFileSizeBytes,
    });

    if (error && !error.message.toLowerCase().includes('already exists')) {
      throw new BadRequestException(`Bucket setup failed: ${error.message}`);
    }

    this.bucketReady = true;
  }

  private buildStoragePath(companyId: string, clientId: string, originalName?: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const extension = extname(originalName || '').toLowerCase();
    return `${companyId}/${clientId}/${year}/${month}/${randomUUID()}${extension}`;
  }

  private async enqueueProcessingIfNeeded(assetId: string, mimeType: string) {
    if (mimeType.startsWith('audio/') || mimeType.startsWith('image/')) {
      await this.queueService.addMediaJob({ media_asset_id: assetId });
    }
  }
}
