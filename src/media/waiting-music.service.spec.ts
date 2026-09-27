import { WaitingMusicService } from './waiting-music.service';
import {
  normalizeWaitingMusic,
  pcmToWav,
  wavToPcm,
} from './waiting-music.util';
const id = '11111111-1111-1111-1111-111111111111';
function setup() {
  const prisma = {
    painel_clients: {
      findUnique: jest.fn().mockResolvedValue({ company_id: 'company' }),
    },
    media_assets: {
      findFirst: jest.fn().mockResolvedValue({
        id,
        storage_bucket: 'b',
        storage_path: `company/client/${id}.wav`,
        file_size: 100,
        updated_at: new Date(0),
      }),
    },
  };
  const media = {
    supportsBucket: jest.fn().mockReturnValue(true),
    readStoredAudio: jest.fn().mockResolvedValue(pcmToWav(Buffer.alloc(960))),
  };
  return {
    prisma,
    media,
    service: new WaitingMusicService(prisma as any, media as any),
  };
}
it('checks company and client ownership even for cached tracks', async () => {
  const { prisma, media, service } = setup();
  await expect(
    service.authorize('client', { company_id: 'other' }),
  ).rejects.toThrow();
  await expect(
    service.authorize('client', {
      company_id: 'other',
      role: 'platform_admin',
    }),
  ).resolves.toBe('company');
  const first = await service.audio('client', id);
  expect(wavToPcm(first).length).toBe(960);
  await service.audio('client', id);
  expect(media.readStoredAudio).toHaveBeenCalledTimes(1);
  expect(prisma.media_assets.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        client_id: 'client',
        company_id: 'company',
        id,
      }),
    }),
  );
  prisma.media_assets.findFirst.mockResolvedValueOnce(null as any);
  await expect(service.audio('client', id)).rejects.toThrow();
});
it('rejects enabled settings without an owned file and invalid volume', async () => {
  const { prisma, service } = setup();
  for (const raw of [
    { enabled: true, media_asset_id: null, volume: 20 },
    { enabled: false, volume: 101 },
    { enabled: true, media_asset_id: id, volume: NaN },
  ]) {
    await expect(service.validateConfig('client', raw)).rejects.toThrow();
  }
  prisma.media_assets.findFirst.mockResolvedValueOnce(null as any);
  await expect(
    service.validateConfig('client', {
      enabled: true,
      media_asset_id: id,
      volume: 20,
    }),
  ).rejects.toThrow();
  await expect(
    service.validateConfig(null, {
      enabled: false,
      media_asset_id: null,
      volume: 20,
    }),
  ).resolves.toMatchObject({ enabled: false });
});
it('rejects foreign storage buckets and paths before reading bytes', async () => {
  const { prisma, media, service } = setup();
  const asset = await prisma.media_assets.findFirst();
  prisma.media_assets.findFirst.mockResolvedValueOnce({
    ...asset,
    storage_path: `company/client/../other/${id}.wav`,
  });
  await expect(service.audio('client', id)).rejects.toThrow();
  media.supportsBucket.mockReturnValueOnce(false);
  await expect(service.audio('client', id)).rejects.toThrow();
  expect(media.readStoredAudio).not.toHaveBeenCalled();
});
it('rejects unsupported and oversized uploads before conversion', async () => {
  await expect(
    normalizeWaitingMusic(Buffer.from('not audio')),
  ).rejects.toThrow();
  await expect(
    normalizeWaitingMusic(Buffer.alloc(10 * 1024 * 1024 + 1)),
  ).rejects.toThrow();
  expect(() => wavToPcm(Buffer.alloc(100))).toThrow();
});
