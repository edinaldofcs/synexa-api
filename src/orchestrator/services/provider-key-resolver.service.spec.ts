import { ConfigService } from '@nestjs/config';
import { ProviderKeyResolverService } from './provider-key-resolver.service';

describe('ProviderKeyResolverService', () => {
  it('does not fall back to a credential from another tenant', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      provider_credentials: {
        findFirst,
        update: jest.fn(),
      },
      painel_clients: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ metadata: {}, company_id: null }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const service = new ProviderKeyResolverService(
      prisma as any,
      config as unknown as ConfigService,
    );

    await expect(
      service.resolveApiKey('client-1', 'test-provider'),
    ).resolves.toBe('');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects encrypted credentials when ENCRYPTION_KEY is missing', async () => {
    const prisma = {
      provider_credentials: {
        findFirst: jest.fn().mockResolvedValue({ api_key_enc: 'enc:opaque' }),
        update: jest.fn().mockResolvedValue({}),
      },
      painel_clients: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ metadata: {}, company_id: null }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const service = new ProviderKeyResolverService(
      prisma as any,
      config as unknown as ConfigService,
    );
    const encryptionKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;

    try {
      await expect(
        service.resolveApiKey('client-1', 'test-provider'),
      ).resolves.toBe('');
    } finally {
      if (encryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = encryptionKey;
    }
  });
});
