import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { PrismaService } from '../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateMediaAssetDto } from './dto/create-media-asset.dto';
import { UpdateMediaAssetDto } from './dto/update-media-asset.dto';
import { UploadMediaAssetDto } from './dto/upload-media-asset.dto';
import { StorageProvider } from './providers/storage-provider.interface';

const DEFAULT_ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
];

@Injectable()
export class MediaService {
  private readonly maxFileSizeBytes: number;
  private readonly bucketName: string;
  private readonly supabase: SupabaseClient | null;
  private readonly isDevelopment: boolean;
  private bucketReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
    @Inject('STORAGE_PROVIDER')
    private readonly storageProvider: StorageProvider | null,
  ) {
    this.maxFileSizeBytes = configService.get<number>(
      'UPLOAD_MAX_SIZE',
      50 * 1024 * 1024,
    );
    this.bucketName = configService.get<string>('MEDIA_BUCKET', 'synexa-media');
    this.isDevelopment =
      configService.get<string>('ENVIRONMENT', 'development') === 'development';

    const supabaseUrl = configService.get<string>('SUPABASE_URL');
    const serviceRoleKey =
      configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      configService.get<string>('SUPABASE_SECRET_KEY');

    this.supabase =
      supabaseUrl && serviceRoleKey
        ? createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
  }

  async findAll(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) throw new ForbiddenException('User has no company');
    return this.prisma.media_assets.findMany({
      where: { company_id: user.company_id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async createAsset(
    clientId: string,
    dto: CreateMediaAssetDto,
    userId: string,
  ) {
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

  async uploadAsset(
    clientId: string,
    file: any,
    dto: UploadMediaAssetDto,
    userId: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('File is required');

    const companyId = await this.getAuthorizedCompanyId(clientId, userId);

    const detectedType = await fileTypeFromBuffer(file.buffer);
    if (!detectedType) {
      throw new BadRequestException(
        'Could not determine file type from content',
      );
    }
    if (!this.isAllowedMime(detectedType.mime)) {
      throw new BadRequestException(
        `Unsupported file type: ${detectedType.mime}`,
      );
    }

    this.validateFileSize(file.size);

    if (dto.message_id) {
      await this.validateMessageAccess(dto.message_id, companyId, clientId);
    }

    await this.ensureBucket();

    const storagePath = this.buildStoragePath(
      companyId,
      clientId,
      file.originalname,
    );

    if (this.isDevelopment && this.storageProvider) {
      const { error } = await this.storageProvider.upload(
        this.bucketName,
        storagePath,
        file.buffer,
        { contentType: detectedType.mime, cacheControl: '3600' },
      );
      if (error)
        throw new BadRequestException(`Storage upload failed: ${error}`);
    } else {
      this.ensureSupabaseConfigured();
      const { error } = await this.supabase!.storage.from(
        this.bucketName,
      ).upload(storagePath, file.buffer, {
        cacheControl: '3600',
        contentType: detectedType.mime,
        upsert: false,
      });
      if (error)
        throw new BadRequestException(
          `Storage upload failed: ${error.message}`,
        );
    }

    const asset = await this.prisma.media_assets.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        message_id: dto.message_id || null,
        storage_bucket: this.bucketName,
        storage_path: storagePath,
        mime_type: detectedType.mime,
        file_size: file.size || null,
        status: 'stored',
        metadata: {
          ...(dto.metadata || {}),
          original_name: file.originalname,
          detected_ext: detectedType.ext,
        } as any,
      },
    });

    await this.enqueueProcessingIfNeeded(asset.id, asset.mime_type);
    return asset;
  }

  async storeInlineAsset(params: {
    companyId: string;
    clientId: string;
    messageId: string;
    mimeType: string;
    data: string;
    transcript?: string | null;
  }) {
    const mimeType = params.mimeType.split(';', 1)[0].trim().toLowerCase();
    if (!this.isAllowedMime(mimeType)) {
      throw new BadRequestException(`Unsupported media type: ${mimeType}`);
    }

    const buffer = Buffer.from(params.data, 'base64');
    if (!buffer.length) {
      throw new BadRequestException('Inline media data is empty');
    }
    this.validateFileSize(buffer.length);

    await this.ensureBucket();
    const storagePath = this.buildStoragePath(
      params.companyId,
      params.clientId,
      `inline.${this.extensionForMime(mimeType)}`,
    );

    if (this.isDevelopment && this.storageProvider) {
      const { error } = await this.storageProvider.upload(
        this.bucketName,
        storagePath,
        buffer,
        { contentType: mimeType, cacheControl: '3600' },
      );
      if (error)
        throw new BadRequestException(`Storage upload failed: ${error}`);
    } else {
      this.ensureSupabaseConfigured();
      const { error } = await this.supabase!.storage.from(
        this.bucketName,
      ).upload(storagePath, buffer, {
        cacheControl: '3600',
        contentType: mimeType,
        upsert: false,
      });
      if (error)
        throw new BadRequestException(
          `Storage upload failed: ${error.message}`,
        );
    }

    return this.prisma.media_assets.create({
      data: {
        company_id: params.companyId,
        client_id: params.clientId,
        message_id: params.messageId,
        storage_bucket: this.bucketName,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size: buffer.length,
        transcript: params.transcript || null,
        status: 'ready',
        metadata: { source: 'enterprise_chat_test', inline: true } as any,
      },
    });
  }

  async createSignedUrl(
    assetId: string,
    userId: string,
    expiresInSeconds = 300,
  ) {
    const clampedExpiresIn = Math.min(Math.max(expiresInSeconds, 60), 3600);

    const asset = await this.findOne(assetId, userId);
    if (!asset.storage_bucket || !asset.storage_path) {
      throw new BadRequestException('Media asset has no stored file');
    }

    if (this.isDevelopment && this.storageProvider) {
      const { signedUrl, error } = await this.storageProvider.createSignedUrl(
        asset.storage_bucket,
        asset.storage_path,
        clampedExpiresIn,
      );
      if (error) throw new BadRequestException(`Signed URL failed: ${error}`);
      return {
        asset_id: asset.id,
        signed_url: signedUrl,
        expires_in: clampedExpiresIn,
      };
    }

    this.ensureSupabaseConfigured();
    const { data, error } = await this.supabase!.storage.from(
      asset.storage_bucket,
    ).createSignedUrl(asset.storage_path, clampedExpiresIn);

    if (error)
      throw new BadRequestException(`Signed URL failed: ${error.message}`);

    return {
      asset_id: asset.id,
      signed_url: data.signedUrl,
      expires_in: clampedExpiresIn,
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

  private async getAuthorizedCompanyId(
    clientId: string,
    userId: string,
  ): Promise<string> {
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

  private async validateMessageAccess(
    messageId: string,
    companyId: string,
    clientId: string,
  ) {
    const message = await this.prisma.messages.findUnique({
      where: { id: messageId },
      select: {
        company_id: true,
        conversations: { select: { client_id: true } },
      },
    });

    if (
      !message ||
      message.company_id !== companyId ||
      message.conversations.client_id !== clientId
    ) {
      throw new NotFoundException('Message not found');
    }
  }

  private isAllowedMime(mime: string): boolean {
    return (
      DEFAULT_ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) ||
      DEFAULT_ALLOWED_MIME_TYPES.includes(mime)
    );
  }

  private validateMimeType(mimeType: string) {
    const isAllowed =
      DEFAULT_ALLOWED_MIME_PREFIXES.some((prefix) =>
        mimeType.startsWith(prefix),
      ) || DEFAULT_ALLOWED_MIME_TYPES.includes(mimeType);

    if (!isAllowed) {
      throw new BadRequestException(`Unsupported media type: ${mimeType}`);
    }
  }

  private validateFileSize(fileSize?: number) {
    if (fileSize && fileSize > this.maxFileSizeBytes) {
      throw new BadRequestException(
        `File exceeds max size of ${this.maxFileSizeBytes} bytes`,
      );
    }
  }

  private ensureSupabaseConfigured() {
    if (!this.supabase) {
      throw new BadRequestException('Supabase storage is not configured');
    }
  }

  private async ensureBucket() {
    if (this.bucketReady) return;

    if (this.isDevelopment && this.storageProvider) {
      await this.storageProvider.ensureBucket(this.bucketName);
      this.bucketReady = true;
      return;
    }

    this.ensureSupabaseConfigured();
    const existing = await this.supabase!.storage.getBucket(this.bucketName);
    if (!existing.error) {
      this.bucketReady = true;
      return;
    }

    const { error } = await this.supabase!.storage.createBucket(
      this.bucketName,
      {
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
      },
    );

    if (error && !error.message.toLowerCase().includes('already exists')) {
      throw new BadRequestException(`Bucket setup failed: ${error.message}`);
    }

    this.bucketReady = true;
  }

  private buildStoragePath(
    companyId: string,
    clientId: string,
    originalName?: string,
  ) {
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

  private extensionForMime(mimeType: string) {
    if (mimeType === 'audio/mpeg') return 'mp3';
    if (mimeType === 'audio/ogg') return 'ogg';
    if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return 'wav';
    if (mimeType === 'audio/webm') return 'webm';
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/svg+xml') return 'svg';
    return mimeType.split('/')[1] || 'bin';
  }
}
