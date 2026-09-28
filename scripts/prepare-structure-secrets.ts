/** Run offline after backup, before the signing-secret migration. Never prints credentials. */
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { encrypt, decrypt } from '../src/common/utils/crypto.util';
const db = new PrismaClient();
async function run() {
  const key = process.env.ENCRYPTION_KEY || '';
  if (key.length < 32) throw new Error('ENCRYPTION_KEY required');
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; secret_hash: string }[]>(
      Prisma.sql`SELECT id, secret_hash FROM webhook_endpoints WHERE secret_hash IS NOT NULL FOR UPDATE`,
    );
    for (const row of rows) {
      const sealed = row.secret_hash.startsWith('enc:')
        ? row.secret_hash
        : `enc:${encrypt(row.secret_hash, key)}`;
      const plain = decrypt(sealed.slice(4), key);
      if (!row.secret_hash.startsWith('enc:') && plain !== row.secret_hash)
        throw new Error('Secret verification failed');
      await tx.$executeRaw(
        Prisma.sql`UPDATE webhook_endpoints SET secret_hash=${sealed} WHERE id=${row.id}::uuid`,
      );
    }
    console.log(`Signing secrets protected: ${rows.length}`);
    const credentials = await tx.provider_credentials.findMany({
      select: { id: true, api_key_enc: true },
    });
    for (const credential of credentials) {
      const encrypted = credential.api_key_enc.startsWith('enc:')
        ? credential.api_key_enc
        : `enc:${encrypt(credential.api_key_enc, key)}`;
      decrypt(encrypted.slice(4), key);
      await tx.provider_credentials.update({
        where: { id: credential.id },
        data: { api_key_enc: encrypted },
      });
    }
    const clients = await tx.painel_clients.findMany({
      select: { id: true, company_id: true, metadata: true },
    });
    for (const client of clients) {
      const metadata = client.metadata as Record<string, any> | null;
      if (!metadata?.llm_providers) continue;
      for (const [name, settings] of Object.entries(
        metadata.llm_providers as Record<string, any>,
      )) {
        const raw = settings.apiKey;
        if (
          typeof raw === 'string' &&
          raw.trim() &&
          !raw.includes('...') &&
          !raw.includes('***') &&
          raw !== 'stored'
        ) {
          const encrypted = raw.startsWith('enc:')
            ? raw
            : `enc:${encrypt(raw, key)}`;
          decrypt(encrypted.slice(4), key);
          await tx.provider_credentials.upsert({
            where: {
              client_id_provider_label: {
                client_id: client.id,
                provider: name.toLowerCase(),
                label: 'default',
              },
            },
            update: {},
            create: {
              client_id: client.id,
              company_id: client.company_id,
              provider: name.toLowerCase(),
              api_key_enc: encrypted,
              label: 'default',
              enabled_models: settings.enabledModels || [],
            },
          });
        }
        delete settings.apiKey;
      }
      await tx.painel_clients.update({
        where: { id: client.id },
        data: { metadata },
      });
    }
  });
}
run()
  .catch(() => {
    console.error(
      'Secret preparation failed; database transaction rolled back',
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
