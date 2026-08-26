import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function cleanClientMetadata() {
  const client = await prisma.painel_clients.findUnique({
    where: { id: '00000000-0000-0000-0000-000000000002' },
  });

  if (!client) return;

  const meta = (client.metadata as any) || {};

  // Remove chaves antigas de agentes do metadata
  delete meta['00000000-0000-0000-0000-000000000011'];
  delete meta['00000000-0000-0000-0000-000000000012'];
  delete meta['00000000-0000-0000-0000-000000000013'];
  delete meta['00000000-0000-0000-0000-000000000014'];
  delete meta['6e2dbe26-3289-4133-ba8d-2eeb9028e388'];
  if (meta.metadata?.activation_rules) {
    delete meta.metadata.activation_rules;
  }

  await prisma.painel_clients.update({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    data: {
      metadata: meta,
      agent_name: 'Sofia - Assistente Synexa',
    },
  });

  console.log('✅ Metadata do cliente limpo com sucesso.');
}

cleanClientMetadata()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
