import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decrypt } from '../../common/utils/crypto.util';

@Injectable()
export class ProviderKeyResolverService {
  private readonly logger = new Logger(ProviderKeyResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async resolveApiKey(clientId: string, provider: string): Promise<string> {
    const providerLower = provider.toLowerCase();

    // 1. Tenta buscar da tabela dedicada provider_credentials (Fase 2)
    try {
      const credential = await this.prisma.provider_credentials.findFirst({
        where: {
          client_id: clientId,
          provider: providerLower,
          status: 'active',
        },
      });

      if (credential?.api_key_enc) {
        // Atualiza last_used_at de forma não-bloqueante
        void this.prisma.provider_credentials
          .update({
            where: { id: credential.id },
            data: { last_used_at: new Date() },
          })
          .catch(() => {});

        let rawKey = credential.api_key_enc;
        if (rawKey.startsWith('enc:')) {
          const encryptionKey =
            this.configService.get<string>('ENCRYPTION_KEY');
          if (encryptionKey) {
            try {
              rawKey = decrypt(rawKey.slice(4), encryptionKey);
            } catch (err) {
              this.logger.warn(
                {
                  provider: providerLower,
                  clientId,
                  error: (err as Error).message,
                },
                'Falha ao descriptografar API key de provider_credentials',
              );
              rawKey = '';
            }
          }
        }
        if (rawKey) return rawKey;
      }
    } catch (err) {
      this.logger.warn(
        { provider: providerLower, clientId, error: (err as Error).message },
        'Erro ao consultar provider_credentials, usando fallback metadata',
      );
    }

    // 2. Fallback: metadata.llm_providers
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const providers = (client?.metadata as any)?.llm_providers || {};
    const config = providers[provider] || providers[providerLower];
    let apiKey = config?.apiKey || '';

    if (apiKey && typeof apiKey === 'string' && apiKey.startsWith('enc:')) {
      const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
      if (encryptionKey) {
        try {
          apiKey = decrypt(apiKey.slice(4), encryptionKey);
        } catch (err) {
          this.logger.warn(
            { provider, clientId, error: (err as Error).message },
            'Falha ao descriptografar API key de metadata',
          );
          apiKey = '';
        }
      }
    }

    // 3. Fallback: Environment Variables
    if (!apiKey) {
      const envKeyName = `${provider.toUpperCase()}_API_KEY`;
      apiKey =
        this.configService.get<string>(envKeyName) ||
        process.env[envKeyName] ||
        '';
    }

    return apiKey;
  }

  async resolveProviderConfig(
    clientId: string,
    provider: string,
  ): Promise<{ apiKey: string; enabledModels?: string[] }> {
    const providerLower = provider.toLowerCase();

    // 1. Tenta buscar da tabela dedicada provider_credentials
    try {
      const credential = await this.prisma.provider_credentials.findFirst({
        where: {
          client_id: clientId,
          provider: providerLower,
          status: 'active',
        },
      });

      if (credential?.api_key_enc) {
        void this.prisma.provider_credentials
          .update({
            where: { id: credential.id },
            data: { last_used_at: new Date() },
          })
          .catch(() => {});

        let rawKey = credential.api_key_enc;
        if (rawKey.startsWith('enc:')) {
          const encryptionKey =
            this.configService.get<string>('ENCRYPTION_KEY');
          if (encryptionKey) {
            try {
              rawKey = decrypt(rawKey.slice(4), encryptionKey);
            } catch {
              rawKey = '';
            }
          }
        }

        const enabledModels = Array.isArray(credential.enabled_models)
          ? (credential.enabled_models as string[])
          : [];

        if (rawKey) {
          return { apiKey: rawKey, enabledModels };
        }
      }
    } catch {}

    // 2. Fallback: metadata
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const providers = (client?.metadata as any)?.llm_providers || {};
    const config = providers[provider] || providers[providerLower] || {};
    let apiKey = config.apiKey || '';

    if (apiKey && typeof apiKey === 'string' && apiKey.startsWith('enc:')) {
      const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
      if (encryptionKey) {
        try {
          apiKey = decrypt(apiKey.slice(4), encryptionKey);
        } catch {
          apiKey = '';
        }
      }
    }

    if (!apiKey) {
      const envKeyName = `${provider.toUpperCase()}_API_KEY`;
      apiKey =
        this.configService.get<string>(envKeyName) ||
        process.env[envKeyName] ||
        '';
    }

    return {
      apiKey,
      enabledModels: config.enabledModels || [],
    };
  }
}
