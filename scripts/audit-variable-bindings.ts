/** Usage: node -r ts-node/register scripts/audit-variable-bindings.ts
 * Reads configuration only. Does not inspect conversations or personal values.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  auditVariableConfiguration,
  VariableAuditReference,
} from '../src/common/utils/variable-binding-audit.util';

async function main() {
  const prisma = new PrismaClient({ log: [] });
  try {
    const [clients, apis, agents] = await Promise.all([
      prisma.painel_clients.findMany({
        select: {
          id: true,
          company_id: true,
          agent_name: true,
          company_name: true,
          metadata: true,
        },
      }),
      prisma.painel_apis.findMany({
        select: {
          id: true,
          client_id: true,
          body: true,
          parameters: true,
          extract_data: true,
        },
      }),
      prisma.painel_agents.findMany({
        select: {
          id: true,
          client_id: true,
          system_prompt: true,
          persona_blocks: true,
          transitions: true,
        },
      }),
    ]);
    const references: VariableAuditReference[] = [];
    for (const client of clients) {
      for (const field of ['agent_name', 'company_name'] as const) {
        if (!client[field]?.trim())
          references.push({
            kind: 'client',
            id: client.id,
            path: field,
            reason: 'required_identity_missing',
          });
      }
      references.push(
        ...auditVariableConfiguration('client', client.id, client.metadata),
      );
    }
    for (const api of apis)
      references.push(
        ...auditVariableConfiguration(
          'api',
          api.id,
          {
            body: api.body,
            parameters: api.parameters,
            extract_data: api.extract_data,
          },
          api.client_id,
        ),
      );
    for (const agent of agents)
      references.push(
        ...auditVariableConfiguration(
          'agent',
          agent.id,
          {
            system_prompt: agent.system_prompt,
            persona_blocks: agent.persona_blocks,
            transitions: agent.transitions,
          },
          agent.client_id,
        ),
      );
    process.stdout.write(
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          counts: {
            clients: clients.length,
            apis: apis.length,
            agents: agents.length,
          },
          references,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  const code =
    (error as { code?: string; errorCode?: string })?.code ||
    (error as { errorCode?: string })?.errorCode;
  const safeCode =
    typeof code === 'string' && /^P[0-9]{4}$/.test(code) ? code : 'unavailable';
  // Driver errors can contain connection information. Keep output value-free.
  process.stderr.write(
    `CONFIGURATION_AUDIT_FAILED (${safeCode}): verifique o acesso ao banco configurado.\n`,
  );
  process.exitCode = 1;
});
