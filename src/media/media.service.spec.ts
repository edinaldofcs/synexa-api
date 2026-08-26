import { Test, TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { QueueService } from '../queue/queue.service';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

jest.mock('file-type');

import { fileTypeFromBuffer } from 'file-type';

describe('MediaService', () => {
  let service: MediaService;

  const mockPrisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
    media_assets: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    messages: { findUnique: jest.fn() },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockQueueService = {
    addMediaJob: jest.fn(),
  };

  const mockStorageProvider = {
    upload: jest.fn(),
    download: jest.fn(),
    createSignedUrl: jest.fn(),
    ensureBucket: jest.fn(),
  };

  function buildMediaModule() {
    return Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: QueueService, useValue: mockQueueService },
        { provide: 'STORAGE_PROVIDER', useValue: mockStorageProvider },
      ],
    }).compile();
  }

  async function freshService(): Promise<MediaService> {
    const module = await buildMediaModule();
    return module.get<MediaService>(MediaService);
  }

  beforeEach(async () => {
    mockConfigService.get.mockImplementation(
      (key: string, defaultValue?: any) => {
        const env: Record<string, any> = {
          ENVIRONMENT: 'development',
          UPLOAD_MAX_SIZE: 50 * 1024 * 1024,
          MEDIA_BUCKET: 'synexa-media',
        };
        return env[key] ?? defaultValue;
      },
    );

    service = await freshService();
    jest.clearAllMocks();
  });

  function assetStub(overrides?: Record<string, any>) {
    return { id: 'asset-1', mime_type: 'image/png', ...overrides };
  }

  // ---------------------------------------------------------------------------
  // findAll
  // ---------------------------------------------------------------------------
  describe('findAll', () => {
    it('should return paginated assets for user company', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findMany.mockResolvedValue([
        { id: 'asset-1' },
        { id: 'asset-2' },
      ]);

      const result = await service.findAll('user-1');

      expect(result).toEqual([{ id: 'asset-1' }, { id: 'asset-2' }]);
      expect(mockPrisma.media_assets.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { company_id: 'company-1' },
        }),
      );
    });

    it('should throw ForbiddenException when user is not found', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);

      await expect(service.findAll('bad-user')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException when user has no company_id', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({ company_id: null });

      await expect(service.findAll('user-no-company')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // createAsset
  // ---------------------------------------------------------------------------
  describe('createAsset', () => {
    const defaultDto = {
      mime_type: 'image/png',
      file_name: 'photo.png',
      file_size: 1024,
    };

    beforeEach(() => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.create.mockResolvedValue(assetStub());
    });

    it('should create asset with valid MIME type', async () => {
      const result = await service.createAsset(
        'client-1',
        defaultDto,
        'user-1',
      );

      expect(result).toHaveProperty('id', 'asset-1');
      expect(mockPrisma.media_assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            client_id: 'client-1',
            mime_type: 'image/png',
            file_size: 1024,
          }),
        }),
      );
    });

    it('should accept application/pdf as valid MIME type', async () => {
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ mime_type: 'application/pdf' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, mime_type: 'application/pdf' },
        'user-1',
      );

      expect(mockPrisma.media_assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mime_type: 'application/pdf' }),
        }),
      );
    });

    it('should accept audio/ prefix', async () => {
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ mime_type: 'audio/mpeg' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, mime_type: 'audio/mpeg' },
        'user-1',
      );

      expect(mockPrisma.media_assets.create).toHaveBeenCalled();
    });

    it('should accept video/ prefix', async () => {
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ mime_type: 'video/mp4' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, mime_type: 'video/mp4' },
        'user-1',
      );

      expect(mockPrisma.media_assets.create).toHaveBeenCalled();
    });

    it('should validate message access when message_id is provided', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        company_id: 'company-1',
        conversations: { client_id: 'client-1' },
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ mime_type: 'application/pdf' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, message_id: 'msg-1', mime_type: 'application/pdf' },
        'user-1',
      );

      expect(mockPrisma.messages.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'msg-1' } }),
      );
    });

    it('should throw BadRequestException for unsupported MIME type', async () => {
      await expect(
        service.createAsset(
          'client-1',
          { ...defaultDto, mime_type: 'application/x-msdownload' },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when file_size exceeds max limit', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const env: Record<string, any> = {
            ENVIRONMENT: 'development',
            UPLOAD_MAX_SIZE: 1024,
            MEDIA_BUCKET: 'synexa-media',
          };
          return env[key] ?? defaultValue;
        },
      );

      const s = await freshService();
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });

      await expect(
        s.createAsset('client-1', { ...defaultDto, file_size: 5000 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when client belongs to a different company', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-2',
      });

      await expect(
        service.createAsset('client-1', defaultDto, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should enqueue processing for audio file', async () => {
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-audio', mime_type: 'audio/mpeg' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, mime_type: 'audio/mpeg' },
        'user-1',
      );

      expect(mockQueueService.addMediaJob).toHaveBeenCalledWith({
        media_asset_id: 'asset-audio',
      });
    });

    it('should NOT enqueue processing for video file', async () => {
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-video', mime_type: 'video/mp4' }),
      );

      await service.createAsset(
        'client-1',
        { ...defaultDto, mime_type: 'video/mp4' },
        'user-1',
      );

      expect(mockQueueService.addMediaJob).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when message_id refers to message in different company', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        company_id: 'company-2',
        conversations: { client_id: 'client-1' },
      });

      await expect(
        service.createAsset(
          'client-1',
          { ...defaultDto, message_id: 'msg-1' },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when message does not exist', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue(null);

      await expect(
        service.createAsset(
          'client-1',
          { ...defaultDto, message_id: 'msg-99' },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user has no company_id', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({ company_id: null });

      await expect(
        service.createAsset('client-1', defaultDto, 'user-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------------------
  // findAllByClient
  // ---------------------------------------------------------------------------
  describe('findAllByClient', () => {
    it('should return assets for authorized client', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findMany.mockResolvedValue([
        { id: 'asset-1' },
        { id: 'asset-2' },
      ]);

      const result = await service.findAllByClient('client-1', 'user-1');

      expect(result).toHaveLength(2);
      expect(mockPrisma.media_assets.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { client_id: 'client-1' } }),
      );
    });

    it('should throw NotFoundException when client belongs to different company', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-2',
      });

      await expect(
        service.findAllByClient('client-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // findOne
  // ---------------------------------------------------------------------------
  describe('findOne', () => {
    it('should return asset for authorized user', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findUnique.mockResolvedValue(
        assetStub({ client_id: 'client-1' }),
      );

      const result = await service.findOne('asset-1', 'user-1');

      expect(result).toHaveProperty('id', 'asset-1');
      expect(result).toHaveProperty('mime_type', 'image/png');
    });

    it('should throw NotFoundException when asset does not exist', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findUnique.mockResolvedValue(null);

      await expect(service.findOne('non-existent', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when user has no company', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);
      mockPrisma.media_assets.findUnique.mockResolvedValue(
        assetStub({ client_id: 'client-1' }),
      );

      await expect(service.findOne('asset-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException when asset client belongs to different company (cross-tenant)', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findUnique.mockResolvedValue(
        assetStub({ client_id: 'client-1' }),
      );
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-2',
      });

      await expect(service.findOne('asset-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // uploadAsset
  // ---------------------------------------------------------------------------
  describe('uploadAsset', () => {
    interface MulterFile {
      originalname: string;
      buffer: Buffer;
      size: number;
      mimetype?: string;
    }

    const makeFile = (overrides: Partial<MulterFile> = {}) =>
      ({
        originalname: 'test.png',
        buffer: Buffer.from('fake-image-data'),
        size: 1024,
        ...overrides,
      }) as any;

    beforeEach(() => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'image/png',
        ext: 'png',
      });
      mockStorageProvider.ensureBucket.mockResolvedValue(undefined);
      mockStorageProvider.upload.mockResolvedValue({
        path: 'uploads/test.png',
      });
      mockPrisma.media_assets.create.mockResolvedValue(assetStub());
    });

    it('should upload file and create asset record', async () => {
      const file = makeFile();

      const result = await service.uploadAsset('client-1', file, {}, 'user-1');

      expect(fileTypeFromBuffer).toHaveBeenCalledWith(file.buffer);
      expect(mockStorageProvider.ensureBucket).toHaveBeenCalledWith(
        'synexa-media',
      );
      expect(mockStorageProvider.upload).toHaveBeenCalled();
      expect(mockPrisma.media_assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            company_id: 'company-1',
            client_id: 'client-1',
            mime_type: 'image/png',
            status: 'stored',
          }),
        }),
      );
      expect(result).toHaveProperty('id', 'asset-1');
    });

    it('should include message_id and metadata in created asset', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        company_id: 'company-1',
        conversations: { client_id: 'client-1' },
      });
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ mime_type: 'application/pdf' }),
      );

      const file = makeFile({ originalname: 'report.pdf' });

      await service.uploadAsset(
        'client-1',
        file,
        { message_id: 'msg-1', metadata: { foo: 'bar' } },
        'user-1',
      );

      expect(mockPrisma.media_assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message_id: 'msg-1',
            metadata: expect.objectContaining({
              foo: 'bar',
              original_name: 'report.pdf',
              detected_ext: 'pdf',
            }),
          }),
        }),
      );
    });

    it('should throw BadRequestException when file buffer is missing', async () => {
      await expect(
        service.uploadAsset('client-1', null, {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when file type cannot be detected', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue(null);
      const file = makeFile({ buffer: Buffer.from('unknown') });

      await expect(
        service.uploadAsset('client-1', file, {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject file with unsupported MIME type via magic bytes', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'application/x-msdownload',
        ext: 'exe',
      });

      const file = makeFile({ buffer: Buffer.from('exe-content') });

      await expect(
        service.uploadAsset('client-1', file, {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject file when size exceeds limit', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const env: Record<string, any> = {
            ENVIRONMENT: 'development',
            UPLOAD_MAX_SIZE: 1024,
            MEDIA_BUCKET: 'synexa-media',
          };
          return env[key] ?? defaultValue;
        },
      );

      const s = await freshService();
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'image/png',
        ext: 'png',
      });

      const file = makeFile({ size: 2048, buffer: Buffer.alloc(2048) });

      await expect(
        s.uploadAsset('client-1', file, {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate message access when message_id is provided during upload', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        company_id: 'company-1',
        conversations: { client_id: 'client-1' },
      });

      const file = makeFile();

      await service.uploadAsset(
        'client-1',
        file,
        { message_id: 'msg-1' },
        'user-1',
      );

      expect(mockPrisma.messages.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'msg-1' } }),
      );
    });

    it('should enqueue processing for audio files', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'audio/mpeg',
        ext: 'mp3',
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-audio', mime_type: 'audio/mpeg' }),
      );

      const file = makeFile({ originalname: 'recording.mp3' });

      await service.uploadAsset('client-1', file, {}, 'user-1');

      expect(mockQueueService.addMediaJob).toHaveBeenCalledWith({
        media_asset_id: 'asset-audio',
      });
    });

    it('should enqueue processing for image files', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'image/jpeg',
        ext: 'jpg',
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-image', mime_type: 'image/jpeg' }),
      );

      const file = makeFile({ originalname: 'photo.jpg' });

      await service.uploadAsset('client-1', file, {}, 'user-1');

      expect(mockQueueService.addMediaJob).toHaveBeenCalledWith({
        media_asset_id: 'asset-image',
      });
    });

    it('should NOT enqueue processing for video files', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'video/mp4',
        ext: 'mp4',
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-video', mime_type: 'video/mp4' }),
      );

      const file = makeFile({ originalname: 'clip.mp4' });

      await service.uploadAsset('client-1', file, {}, 'user-1');

      expect(mockQueueService.addMediaJob).not.toHaveBeenCalled();
    });

    it('should NOT enqueue processing for PDF files', async () => {
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockPrisma.media_assets.create.mockResolvedValue(
        assetStub({ id: 'asset-pdf', mime_type: 'application/pdf' }),
      );

      const file = makeFile({ originalname: 'doc.pdf' });

      await service.uploadAsset('client-1', file, {}, 'user-1');

      expect(mockQueueService.addMediaJob).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when client belongs to different company during upload', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-2',
      });

      const file = makeFile();

      await expect(
        service.uploadAsset('client-1', file, {}, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when storage upload returns error', async () => {
      mockStorageProvider.upload.mockResolvedValue({
        path: '',
        error: 'Disk full',
      });

      const file = makeFile();

      await expect(
        service.uploadAsset('client-1', file, {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // createSignedUrl
  // ---------------------------------------------------------------------------
  describe('createSignedUrl', () => {
    beforeEach(() => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findUnique.mockResolvedValue({
        id: 'asset-1',
        client_id: 'client-1',
        storage_bucket: 'synexa-media',
        storage_path: 'test.png',
      });
      mockStorageProvider.createSignedUrl.mockResolvedValue({
        signedUrl: 'http://localhost/uploads/test.png?t=0&expires=300',
      });
    });

    it('should return signed URL with default 300s expiry', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1');

      expect(result).toEqual({
        asset_id: 'asset-1',
        signed_url: 'http://localhost/uploads/test.png?t=0&expires=300',
        expires_in: 300,
      });
    });

    it('should clamp expiresIn below minimum of 60', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1', 30);

      expect(result.expires_in).toBe(60);
      expect(mockStorageProvider.createSignedUrl).toHaveBeenCalledWith(
        'synexa-media',
        'test.png',
        60,
      );
    });

    it('should clamp expiresIn at exactly 60 when 60 is provided', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1', 60);

      expect(result.expires_in).toBe(60);
    });

    it('should clamp expiresIn above maximum of 3600', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1', 7200);

      expect(result.expires_in).toBe(3600);
      expect(mockStorageProvider.createSignedUrl).toHaveBeenCalledWith(
        'synexa-media',
        'test.png',
        3600,
      );
    });

    it('should clamp expiresIn at exactly 3600 when 3600 is provided', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1', 3600);

      expect(result.expires_in).toBe(3600);
    });

    it('should use expiresIn as-is when within valid range', async () => {
      const result = await service.createSignedUrl('asset-1', 'user-1', 1200);

      expect(result.expires_in).toBe(1200);
      expect(mockStorageProvider.createSignedUrl).toHaveBeenCalledWith(
        'synexa-media',
        'test.png',
        1200,
      );
    });

    it('should throw BadRequestException when asset has no stored file', async () => {
      mockPrisma.media_assets.findUnique.mockResolvedValue({
        id: 'asset-1',
        client_id: 'client-1',
        storage_bucket: null,
        storage_path: null,
      });

      await expect(
        service.createSignedUrl('asset-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent asset', async () => {
      mockPrisma.media_assets.findUnique.mockResolvedValue(null);

      await expect(
        service.createSignedUrl('non-existent', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------
  describe('update', () => {
    beforeEach(() => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.media_assets.findUnique.mockResolvedValue(
        assetStub({ client_id: 'client-1' }),
      );
    });

    it('should update asset status', async () => {
      mockPrisma.media_assets.update.mockResolvedValue({
        id: 'asset-1',
        status: 'ready',
      });

      const result = await service.update(
        'asset-1',
        { status: 'ready' },
        'user-1',
      );

      expect(result).toMatchObject({ id: 'asset-1', status: 'ready' });
    });

    it('should update asset transcript', async () => {
      mockPrisma.media_assets.update.mockResolvedValue({
        id: 'asset-1',
        transcript: 'Hello world',
      });

      const result = await service.update(
        'asset-1',
        { transcript: 'Hello world' },
        'user-1',
      );

      expect(result).toMatchObject({
        id: 'asset-1',
        transcript: 'Hello world',
      });
      expect(mockPrisma.media_assets.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'asset-1' },
          data: expect.objectContaining({ transcript: 'Hello world' }),
        }),
      );
    });

    it('should update multiple fields at once', async () => {
      mockPrisma.media_assets.update.mockResolvedValue({
        id: 'asset-1',
        status: 'failed',
        error_message: 'Processing error',
      });

      const result = await service.update(
        'asset-1',
        { status: 'failed', error_message: 'Processing error' },
        'user-1',
      );

      expect(result).toMatchObject({
        id: 'asset-1',
        status: 'failed',
        error_message: 'Processing error',
      });
    });

    it('should throw ForbiddenException when user has no company', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);
      mockPrisma.media_assets.findUnique.mockResolvedValue(
        assetStub({ client_id: 'client-1' }),
      );

      await expect(
        service.update('asset-1', { status: 'stored' }, 'user-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when asset does not exist', async () => {
      mockPrisma.media_assets.findUnique.mockResolvedValue(null);

      await expect(
        service.update('asset-1', { status: 'stored' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // cross-method tenant isolation
  // ---------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('should prevent findAll with non-existent user', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);

      await expect(service.findAll('bad-user')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should prevent createAsset with user from a different company than client', async () => {
      mockPrisma.users.findUnique.mockResolvedValue({
        company_id: 'company-1',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-2',
      });

      await expect(
        service.createAsset(
          'client-1',
          { mime_type: 'image/png', file_size: 1024 },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
