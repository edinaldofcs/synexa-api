// Diagnóstico: testa resolveApiKey + resolveProviderSettings para tts-custom
// no mesmo ambiente do container (usa o dist compilado).
const path = '/app/dist/src/orchestrator/services/provider-key-resolver.service.js';
const { ProviderKeyResolverService } = require(path);
const { PrismaService } = require('/app/dist/src/common/prisma/prisma.service');
const { ConfigService } = require('@nestjs/config');

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const configService = new ConfigService();
  const resolver = new ProviderKeyResolverService(prisma, configService);
  const clientId = '00000000-0000-0000-0000-000000000002';

  const apiKey = await resolver.resolveApiKey(clientId, 'tts-custom');
  console.log('apiKey len:', (apiKey || '').length, '| vazio?', !apiKey);

  const settings = await resolver.resolveProviderSettings(clientId, 'tts-custom');
  console.log('settings:', JSON.stringify(settings).slice(0, 300));

  const sttKey = await resolver.resolveApiKey(clientId, 'stt-custom');
  const sttSettings = await resolver.resolveProviderSettings(clientId, 'stt-custom');
  console.log('stt settings baseUrl:', sttSettings?.baseUrl || sttSettings?.base_url);

  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
