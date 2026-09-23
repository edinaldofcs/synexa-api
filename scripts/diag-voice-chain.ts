/**
 * Diagnóstico do encadeamento de APIs no canal de VOZ.
 * Replica passo a passo o caminho de VoiceToolsService.execute()
 * com os dados reais do banco para localizar onde a cadeia morre.
 *
 * Uso: npx ts-node --transpile-only scripts/diag-voice-chain.ts [cpf]
 */
import { PrismaClient } from '@prisma/client';
import {
  resolveChainedApiId,
  extractChainingConfig,
} from '../src/common/utils/api-chaining.util';

const prisma = new PrismaClient();
const CLIENT = '00000000-0000-0000-0000-000000000002';
const AGENT = '00000000-0000-0000-0000-000000000011';
const CPF = process.argv[2] || '12345678900';

function toFunctionName(name: string, id: string) {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  return `${slug || 'tool'}_${id.replace(/-/g, '_')}`;
}

async function main() {
  console.log('=== DIAGNÓSTICO ENCADEAMENTO VOZ ===\n');

  // 1. Agente e ferramentas permitidas
  const agent = await prisma.painel_agents.findFirst({
    where: { id: AGENT, client_id: CLIENT },
    select: { allowed_tool_names: true, service_step: true },
  });
  console.log('[1] Agente:', agent?.service_step);
  console.log(
    '    allowed_tool_names:',
    JSON.stringify(agent?.allowed_tool_names),
  );

  const allowedNames = Array.isArray(agent?.allowed_tool_names)
    ? (agent!.allowed_tool_names as unknown[]).filter(
        (n): n is string => typeof n === 'string',
      )
    : [];

  // 2. Replica loadAgentTools (sem LEGACY_TOOL_NAMES filter — aproximação)
  const where: Record<string, unknown> = {
    client_id: CLIENT,
    active: true,
    visible_to_agent: true,
  };
  if (allowedNames.length > 0) {
    where.name = { in: allowedNames };
  } else {
    where.agent_id = AGENT;
  }
  const tools = await prisma.painel_apis.findMany({ where: where as any });
  console.log(
    '\n[2] Tools do agente:',
    tools.map((t) => t.name).join(', '),
  );

  const parent = tools.find((t) => t.name === 'buscar_cpf');
  if (!parent) {
    console.log('    ❌ buscar_cpf NÃO carregada como tool do agente!');
    return;
  }

  // 3. Mapeamento do tool (como em loadAgentTools PÓS-FIX, com resolveNextApiId)
  const UUID_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const resolveNextApiId = (api: Record<string, any>): string | null => {
    const meta =
      typeof api.headers === 'object' && api.headers !== null
        ? (api.headers as Record<string, any>)
        : {};
    const candidates = [api.next_api_id, meta.next_api_id, api.next_tool];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
    }
    return null;
  };
  console.log('\n[3] Tool pai: buscar_cpf');
  console.log('    next_api_id (pós-fix):', resolveNextApiId(parent as any));
  console.log('    next_tool:', parent.next_tool);
  console.log('    extract_data._chaining:', JSON.stringify((parent.extract_data as any)?._chaining));

  // 4. Resolução da cadeia
  const legacyNextApiId = resolveNextApiId(parent as any);
  const cfg = extractChainingConfig(parent.extract_data);
  console.log('\n[4] extractChainingConfig:', JSON.stringify(cfg));
  const consolidated = { contrato: 'MOCK', cliente_cpf: CPF };
  const nextApiId = resolveChainedApiId(
    parent.extract_data,
    consolidated,
    legacyNextApiId,
  );
  console.log('    RESOLVED nextApiId:', nextApiId);

  if (!nextApiId) {
    console.log('    ❌ CADEIA NÃO RESOLVIDA — encadeamento abortado aqui!');
    return;
  }

  // 5. Busca da API filha (UUID-safe, como no execute() pós-fix)
  const isUuidValue = UUID_SHAPE.test(nextApiId.trim());
  const nextApi = await prisma.painel_apis.findFirst({
    where: {
      ...(isUuidValue
        ? { OR: [{ id: nextApiId }, { name: nextApiId }] }
        : { name: nextApiId }),
      active: true,
      client_id: CLIENT,
    } as any,
  });
  console.log('\n[5] API filha encontrada:', nextApi ? nextApi.name : '❌ NULL');
  if (!nextApi) {
    console.log('    ❌ findFirst não achou — encadeamento abortado aqui!');
    return;
  }
  console.log('    url:', nextApi.url);
  console.log('    method:', nextApi.method);

  // 6. Simula a execução da filha (busca por function name como no execute())
  const functionName = toFunctionName(nextApi.name, nextApi.id);
  console.log('\n[6] functionName da filha:', functionName);
  const inAgentTools = tools.find((t) => toFunctionName(t.name, t.id) === functionName);
  console.log(
    '    está nas tools do agente (visible)?',
    inAgentTools ? 'SIM' : 'NÃO (cai no fallback do catálogo)',
  );

  // 7. Executa o HTTP da filha (como o execute() faria)
  console.log('\n[7] Executando HTTP da filha...');
  try {
    const resp = await fetch(nextApi.url!, {
      method: (nextApi.method || 'GET').toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: CPF }),
    });
    const text = await resp.text();
    console.log('    status:', resp.status);
    console.log('    body (primeiros 500 chars):', text.slice(0, 500));
    console.log(
      resp.ok ? '    ✅ filha executou OK' : '    ❌ filha FALHOU (ok=false) — chainTrail não seria gravada!',
    );
  } catch (err: any) {
    console.log('    ❌ EXCEÇÃO no HTTP da filha:', err.message);
  }
}

main()
  .catch((e) => {
    console.error('ERRO:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
