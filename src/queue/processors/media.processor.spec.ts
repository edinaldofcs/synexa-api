import { MediaProcessor } from './media.processor';

describe('MediaProcessor - guarda de tamanho (MAX_MEDIA_BYTES)', () => {
  const build = (asset: Record<string, unknown>) => {
    const prisma = {
      media_assets: {
        findUnique: jest.fn().mockResolvedValue(asset),
        update: jest.fn().mockResolvedValue({}),
      },
      painel_clients: { findUnique: jest.fn() },
    };
    const configService = { get: jest.fn() };
    const processor = new MediaProcessor(
      prisma as never,
      null as never,
      configService as never,
    );
    return { prisma, processor };
  };

  beforeEach(() => {
    process.env.MAX_MEDIA_BYTES = '1000';
    global.fetch = jest.fn() as never;
  });

  afterEach(() => {
    delete process.env.MAX_MEDIA_BYTES;
  });

  it('falha o job antes de baixar quando file_size excede o máximo', async () => {
    const { prisma, processor } = build({
      id: 'asset-1',
      company_id: 'company-1',
      client_id: 'client-1',
      mime_type: 'image/png',
      file_size: 2000,
      storage_bucket: null,
      storage_path: null,
      source_url: 'https://example.com/big.png',
    });

    await expect(
      processor.process({ data: { media_asset_id: 'asset-1' } } as never),
    ).rejects.toThrow(/exceeds the maximum allowed size/);

    expect(prisma.media_assets.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('asset abaixo do limite segue para o download (1x por job)', async () => {
    const { processor } = build({
      id: 'asset-2',
      company_id: 'company-1',
      client_id: 'client-1',
      mime_type: 'audio/mpeg',
      file_size: 500,
      storage_bucket: null,
      storage_path: null,
      source_url: null,
    });

    await expect(
      processor.process({ data: { media_asset_id: 'asset-2' } } as never),
    ).rejects.toThrow(/no storage path or source URL/i);
  });

  it('rejeita download de source_url privada ou localhost (SSRF protection)', async () => {
    const { processor } = build({
      id: 'asset-ssrf',
      company_id: 'company-1',
      client_id: 'client-1',
      mime_type: 'image/png',
      file_size: 100,
      storage_bucket: null,
      storage_path: null,
      source_url: 'http://127.0.0.1:3000/internal',
    });
    (processor as any).isDevelopment = false;

    await expect(
      (processor as any).loadAssetBytes({
        storage_bucket: null,
        storage_path: null,
        source_url: 'http://127.0.0.1:3000/internal',
      }),
    ).rejects.toThrow(/Access to private\/internal IP is not allowed/);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
