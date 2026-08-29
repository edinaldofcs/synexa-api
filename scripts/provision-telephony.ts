/**
 * Provisionamento plug-and-play da telefonia.
 *
 * Cria/atualiza uma rota em `telephony_endpoints` (DID + provider →
 * empresa/cliente/agente) e imprime o passo a passo (MicroSIP, dialplan,
 * segredo gerado). Uso:
 *
 *   npm run telephony:provision -- --did 5511999990000 --client-id <uuid> \
 *     [--provider audiosocket] [--agent-step cobranca] [--label "Recepção"] \
 *     [--secret syn_...] (opcional; gerado forte se ausente)
 *
 * O segredo é exibido uma única vez — só o hash SHA-256+pepper fica no banco.
 */
import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Carrega o .env da API (mesmo comportamento do NestJS em dev)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hashSecret(secret: string): string {
  const pepper = process.env.TELEPHONY_WS_TOKEN_PEPPER || '';
  return createHash('sha256').update(`${secret}${pepper}`).digest('hex');
}

async function main(): Promise<void> {
  const did = argValue('--did');
  const clientId = argValue('--client-id');
  const provider = (argValue('--provider') || 'audiosocket').toLowerCase();
  const agentStep = argValue('--agent-step');
  const label = argValue('--label');
  const inboundSecret = argValue('--secret');

  if (!did || !clientId) {
    console.error(
      'Uso: npm run telephony:provision -- --did <numero> --client-id <uuid> [--provider audiosocket] [--agent-step <step>] [--label <texto>]',
    );
    process.exit(1);
  }

  const client = await prisma.painel_clients.findUnique({
    where: { id: clientId },
    select: { id: true, company_id: true, company_name: true },
  });
  if (!client?.company_id) {
    console.error(`❌ Cliente ${clientId} não encontrado (ou sem empresa).`);
    process.exit(1);
  }

  const secret = inboundSecret || `syn_${randomBytes(24).toString('hex')}`;

  const endpoint = await prisma.telephony_endpoints.upsert({
    where: { did_number_provider: { did_number: did, provider } },
    create: {
      company_id: client.company_id,
      client_id: client.id,
      provider,
      did_number: did,
      label: label || null,
      agent_step: agentStep || null,
      audio_format: 'g711_ulaw',
      inbound_secret_hash: hashSecret(secret),
      config: {},
      enabled: true,
    },
    update: {
      client_id: client.id,
      agent_step: agentStep || null,
      inbound_secret_hash: hashSecret(secret),
      enabled: true,
      updated_at: new Date(),
    },
  });

  console.log('✅ Endpoint de telefonia provisionado');
  console.log(`   id        : ${endpoint.id}`);
  console.log(`   did       : ${endpoint.did_number}`);
  console.log(`   provider  : ${endpoint.provider}`);
  console.log(`   cliente   : ${client.company_name ?? client.company_id}`);
  console.log(
    `   agent_step: ${endpoint.agent_step ?? '(agente ativo padrão)'}`,
  );
  console.log('');
  console.log('🔑 Segredo do ingresso (exibido UMA única vez):');
  console.log(`   ${secret}`);
  console.log('');
  console.log('📱 MicroSIP/Zoiper (chamada de teste):');
  console.log('   Servidor : <ip-do-host>:5060');
  console.log('   Usuário  : microsip');
  console.log(
    `   Senha    : ${process.env.MICROSIP_SIP_PASS || 'microsip-dev'} (env MICROSIP_SIP_PASS)`,
  );
  console.log(`   Discar   : ${did}`);
  console.log('');
  console.log('▶️  Suba a stack de voz: docker compose --profile voice up -d');
}

main()
  .catch((err) => {
    console.error('❌ Falha ao provisionar:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
