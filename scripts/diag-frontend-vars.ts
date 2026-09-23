/**
 * Simula ponta a ponta o fluxo de encadeamento de VOZ e o processamento
 * dos handlers do FRONTEND (useFlowDebugStream), imprimindo exatamente o
 * que cada card de API receberia em `extractedVariables`.
 *
 * Uso: npx ts-node --transpile-only scripts/diag-frontend-vars.ts [cpf]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CLIENT = '00000000-0000-0000-0000-000000000002';
const CPF = process.argv[2] || '08334993942';

function getByPath(obj: any, path: string): any {
  if (!path) return undefined;
  const value = path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as any)[key] : undefined,
      obj,
    );
  if (value !== undefined) return value;
  return obj?.[path];
}

function applyExtractData(raw: any, extractData: any) {
  const mapping =
    typeof extractData === 'object' && extractData !== null ? extractData : {};
  const keys = Object.keys(mapping).filter(
    (k) =>
      ![
        '_fallback_message',
        'fallback_message',
        'validate_field',
        '_chaining',
      ].includes(k),
  );
  if (!keys.length || !raw || typeof raw !== 'object') return raw;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const config = mapping[key];
    if (typeof config === 'boolean' || typeof config === 'number') {
      result[key] = config;
    } else if (typeof config === 'string') {
      result[key] = getByPath(raw, config);
    } else if (config && typeof config === 'object' && 'path' in config) {
      result[key] = getByPath(raw, String(config.path || ''));
    }
  }
  return result;
}

/** Replica o handler flow_telephony_tool_response do useFlowDebugStream */
function frontendToolResponseExtracted(res: any) {
  const isErr =
    res?.ok === false ||
    !!res?.error ||
    (typeof res?.status === 'number' && res.status >= 400);
  let extracted: Record<string, any> | undefined;
  if (!isErr && typeof res === 'object' && res !== null) {
    if (res.data && typeof res.data === 'object') {
      extracted = res.data;
    } else {
      const cleaned = { ...res };
      delete cleaned.ok;
      delete cleaned.status;
      delete cleaned.message;
      delete cleaned._chainTrail;
      if (Object.keys(cleaned).length > 0) {
        extracted = cleaned;
      }
    }
  }
  return { isErr, extracted };
}

/** Replica o handler flow_telephony_chaining do useFlowDebugStream */
function frontendChainingChildExtracted(response: any) {
  let childExtracted: Record<string, any> | undefined;
  if (response && typeof response === 'object') {
    if (response.data && typeof response.data === 'object') {
      childExtracted = response.data;
    } else {
      const cleaned = { ...response };
      delete cleaned.ok;
      delete cleaned.status;
      delete cleaned.message;
      delete cleaned._chainTrail;
      if (Object.keys(cleaned).length > 0) {
        childExtracted = cleaned;
      }
    }
  }
  return childExtracted;
}

async function callApi(api: any, args: Record<string, any>) {
  const body: Record<string, any> = {};
  const bodyCfg =
    typeof api.body === 'object' && api.body !== null ? api.body : {};
  for (const [key, cfgRaw] of Object.entries(bodyCfg)) {
    const cfg = (cfgRaw as any) || {};
    if (cfg.source === 'system') {
      const varName = String(cfg.value ?? '').replace(/[{}]/g, '').trim();
      body[key] = args[varName] ?? args[key] ?? args['cpf'];
    } else if (cfg.source === 'ai') {
      body[key] = args[key];
    }
  }
  const resp = await fetch(api.url, {
    method: (api.method || 'GET').toUpperCase(),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, ok: resp.ok, raw: await resp.json() };
}

async function main() {
  console.log(`=== SIMULAÇÃO VARIÁVEIS EXTRAÍDAS (cpf=${CPF}) ===\n`);

  const parent = await prisma.painel_apis.findFirst({
    where: { name: 'buscar_cpf', client_id: CLIENT },
  });
  const child = await prisma.painel_apis.findFirst({
    where: { name: 'offers', client_id: CLIENT },
  });
  if (!parent || !child) throw new Error('APIs não encontradas');

  // 1. Executa a API pai
  console.log('[1] Executando API pai (buscar_cpf)...');
  const parentCall = await callApi(parent, { cpf: CPF });
  console.log('    HTTP status:', parentCall.status, '| ok:', parentCall.ok);
  const parentExtracted = applyExtractData(
    parentCall.raw,
    parent.extract_data,
  );
  console.log('    applyExtractData:', JSON.stringify(parentExtracted));

  // 2. Executa a API filha (encadeada) com nextArgs = {...args, ...consolidated}
  console.log('\n[2] Executando API filha (offers)...');
  const nextArgs = { cpf: CPF, ...(parentExtracted as any) };
  const childCall = await callApi(child, nextArgs);
  console.log('    HTTP status:', childCall.status, '| ok:', childCall.ok);
  const childExtractedBackend = applyExtractData(
    childCall.raw,
    child.extract_data,
  );
  console.log('    applyExtractData filha:', JSON.stringify(childExtractedBackend));

  const childResult =
    Object.keys(childExtractedBackend as any).length > 0
      ? { ok: true, status: childCall.status, ...childExtractedBackend }
      : {
          ok: true,
          status: childCall.status,
          resultado: childCall.raw ?? 'fallback',
        };

  // 3. Monta a resposta final do pai (como o backend faz)
  const consolidated: Record<string, any> = { ...(parentExtracted as any) };
  Object.assign(consolidated, childResult, { tem_ofertas: true });
  const chainTrail = [
    {
      from: parent.name,
      fromId: parent.id,
      to: child.name,
      toId: child.id,
      arguments: nextArgs,
      response: childResult,
      timestamp: new Date().toISOString(),
    },
  ];
  consolidated._chainTrail = chainTrail;
  const parentResponse = {
    ok: true,
    status: parentCall.status,
    ...consolidated,
  };

  // 4. Handlers do FRONTEND
  console.log('\n[3] Handler flow_telephony_tool_response (PAI):');
  const { isErr, extracted } = frontendToolResponseExtracted(parentResponse);
  console.log('    isErr:', isErr);
  console.log('    extractedVariables:', JSON.stringify(extracted, null, 2));

  console.log('\n[4] Handler flow_telephony_chaining (FILHA):');
  const childEx = frontendChainingChildExtracted(chainTrail[0].response);
  console.log('    extractedVariables:', JSON.stringify(childEx, null, 2));
}

main()
  .catch((e) => {
    console.error('ERRO:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
