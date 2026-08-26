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
    const encryptionKey = this.getEncryptionKey();

    const decryptSafe = (val?: string | null): string => {
      if (!val) return '';
      if (val.startsWith('enc:')) {
        if (!encryptionKey) {
          this.logger.error(
            { provider: providerLower, clientId },
            'ENCRYPTION_KEY ausente; credencial criptografada recusada',
          );
          return '';
        }
        try {
          return decrypt(val.slice(4), encryptionKey);
        } catch (err) {
          this.logger.warn(
            {
              provider: providerLower,
              clientId,
              error: (err as Error).message,
            },
            'Falha ao descriptografar chave',
          );
          return '';
        }
      }
      return val;
    };

    // 1. Tenta buscar da tabela dedicada provider_credentials pelo clientId
    if (clientId) {
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

          const rawKey = decryptSafe(credential.api_key_enc);
          if (
            rawKey &&
            rawKey.trim() &&
            !rawKey.includes('***') &&
            rawKey !== 'stored'
          ) {
            return rawKey.trim();
          }
        }
      } catch (err) {
        this.logger.warn(
          { provider: providerLower, clientId, error: (err as Error).message },
          'Erro ao consultar provider_credentials, tentando fallback',
        );
      }

      // 2. Fallback: metadata.llm_providers do cliente
      try {
        const client = await this.prisma.painel_clients.findUnique({
          where: { id: clientId },
          select: { metadata: true, company_id: true },
        });

        const providers = (client?.metadata as any)?.llm_providers || {};
        const config = providers[provider] || providers[providerLower];
        const apiKey = decryptSafe(config?.apiKey);
        if (
          apiKey &&
          apiKey.trim() &&
          !apiKey.includes('***') &&
          apiKey !== 'stored'
        ) {
          return apiKey.trim();
        }

        // 3. Fallback: busca em outros clientes da mesma empresa
        if (client?.company_id) {
          const companyCred = await this.prisma.provider_credentials.findFirst({
            where: {
              painel_clients: { company_id: client.company_id },
              provider: providerLower,
              status: 'active',
            },
          });
          if (companyCred?.api_key_enc) {
            const rawCompanyKey = decryptSafe(companyCred.api_key_enc);
            if (
              rawCompanyKey &&
              rawCompanyKey.trim() &&
              !rawCompanyKey.includes('***')
            ) {
              return rawCompanyKey.trim();
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          { provider, clientId, error: (err as Error).message },
          'Falha ao buscar chave no metadata do cliente',
        );
      }
    }

    // Fallback explícito: variáveis de ambiente do runtime.
    const envKeyName = `${provider.toUpperCase()}_API_KEY`;
    const envKey =
      this.configService.get<string>(envKeyName) ||
      process.env[envKeyName] ||
      '';

    return envKey ? envKey.trim() : '';
  }

  private getEncryptionKey(): string | null {
    const key =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      process.env.ENCRYPTION_KEY;
    return key?.trim() || null;
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
          const encryptionKey = this.getEncryptionKey();
          if (encryptionKey) {
            try {
              rawKey = decrypt(rawKey.slice(4), encryptionKey);
            } catch {
              rawKey = '';
            }
          } else {
            rawKey = '';
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
      const encryptionKey = this.getEncryptionKey();
      if (encryptionKey) {
        try {
          apiKey = decrypt(apiKey.slice(4), encryptionKey);
        } catch {
          apiKey = '';
        }
      } else {
        apiKey = '';
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
