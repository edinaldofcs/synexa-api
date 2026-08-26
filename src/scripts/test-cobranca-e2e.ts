import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TestChatService } from '../orchestrator/test-chat.service';
import { PrismaService } from '../common/prisma/prisma.service';

async function runTest() {
  console.log('🧪 Inicializando contexto NestJS para Teste E2E do Fluxo de Cobrança...\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const chatService = app.get(TestChatService);
  const prisma = app.get(PrismaService);

  const clientId = '00000000-0000-0000-0000-000000000002';
  const externalUserId = 'test-e2e-cobranca-' + Date.now();

  try {
    // 1. Limpa sessão anterior
    await chatService.clear({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
    });

    console.log('💬 [Turno 1] Cliente: "Olá, meu CPF é 08334993942, gostaria de consultar minhas pendências."');
    const response1 = await chatService.send({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
      message: 'Olá, meu CPF é 08334993942, gostaria de consultar minhas pendências.',
    });

    console.log('\n🤖 Resposta Turno 1:');
    console.log('Texto Retornado:', response1.text);
    console.log('Tool Calls:', JSON.stringify(response1.debug?.toolCalls?.map(t => ({ name: t.name, args: t.arguments, resultStatus: (t.result as any)?.status })), null, 2));
    console.log('Variáveis de Contexto:', JSON.stringify(response1.debug?.contextVariables, null, 2));

    console.log('\n─────────────────────────────────────────────────────────────\n');

    console.log('💬 [Turno 2] Cliente: "Gostei da proposta NEG-001 à vista com 15% de desconto. Vamos fechar o acordo no PIX."');
    const response2 = await chatService.send({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
      message: 'Gostei da proposta NEG-001 à vista com 15% de desconto. Vamos fechar o acordo no PIX.',
    });

    console.log('\n🤖 Resposta Turno 2:');
    console.log('Texto Retornado:', response2.text);
    console.log('Tool Calls:', JSON.stringify(response2.debug?.toolCalls?.map(t => ({ name: t.name, args: t.arguments, resultStatus: (t.result as any)?.status })), null, 2));
    console.log('Variáveis de Contexto:', JSON.stringify(response2.debug?.contextVariables, null, 2));

    console.log('\n🎉 Teste E2E concluído com sucesso!');
  } finally {
    await app.close();
  }
}

runTest().catch((err) => {
  console.error('❌ Erro no teste E2E:', err);
  process.exit(1);
});
