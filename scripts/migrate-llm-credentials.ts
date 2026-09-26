import { PrismaClient } from '@prisma/client';

async function migrateCredentials() {
  const prisma = new PrismaClient();
  try {
    console.log(
      'Iniciando migração de credenciais de metadata para provider_credentials...',
    );

    const clients = await prisma.painel_clients.findMany({
      select: {
        id: true,
        company_id: true,
        metadata: true,
      },
    });

    let migratedCount = 0;

    for (const client of clients) {
      const metadata = (client.metadata as any) || {};
      const providers = metadata.llm_providers || {};

      for (const [providerName, config] of Object.entries(providers)) {
        if (!config || typeof config !== 'object') continue;
        const apiKey = (config as any).apiKey;
        const enabledModels = (config as any).enabledModels || [];

        if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
          await prisma.provider_credentials.upsert({
            where: {
              client_id_provider_label: {
                client_id: client.id,
                provider: providerName.toLowerCase(),
                label: 'default',
              },
            },
            update: {
              api_key_enc: apiKey.trim(),
              enabled_models: enabledModels,
              status: 'active',
              updated_at: new Date(),
            },
            create: {
              company_id: client.company_id,
              client_id: client.id,
              provider: providerName.toLowerCase(),
              api_key_enc: apiKey.trim(),
              label: 'default',
              status: 'active',
              enabled_models: enabledModels,
            },
          });
          migratedCount++;
        }
      }
    }

    console.log(
      `Migração concluída com sucesso! Total de credenciais sincronizadas: ${migratedCount}`,
    );
  } catch (error) {
    console.error('Erro durante a migração de credenciais:', error);
  } finally {
    await prisma.$disconnect();
  }
}

void migrateCredentials();
