import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const client = await prisma.painel_clients.findUnique({
    where: { id: '00000000-0000-0000-0000-000000000002' },
  });
  console.log('CLIENT METADATA:', JSON.stringify(client?.metadata, null, 2));

  const agents = await prisma.painel_agents.findMany({
    where: { client_id: '00000000-0000-0000-0000-000000000002' },
  });
  console.log(
    'AGENTS IN DB:',
    JSON.stringify(
      agents.map((a) => ({
        id: a.id,
        step: a.service_step,
        initial: a.is_initial,
        tools: a.allowed_tool_names,
        activation: a.activation_conditions,
        mode: a.activation_mode,
      })),
      null,
      2,
    ),
  );
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
