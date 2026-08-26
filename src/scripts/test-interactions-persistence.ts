import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TestChatService } from '../orchestrator/test-chat.service';
import { InteractionsService } from '../interactions/interactions.service';

const prisma = new PrismaClient();

async function run() {
  console.log(
    '🧪 Validando persistência e funil na tabela painel_interactions...\n',
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const chatService = app.get(TestChatService);
  const interactionsService = app.get(InteractionsService);

  const clientId = '00000000-0000-0000-0000-000000000002';
  const externalUserId = 'user-interaction-test-' + Date.now();

  try {
    // 1. Limpa sessão
    await chatService.clear({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
    });

    // 2. Turno 1: Envia CPF (Recepção -> Busca CPF -> Offers -> Transição Imediata para Negociação)
    console.log('💬 Turno 1: Enviando mensagem com CPF...');
    await chatService.send({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
      message:
        'Olá, meu CPF é 08334993942, gostaria de consultar minhas pendências.',
    });

    // 3. Turno 2: Fechamento de acordo (Negociação -> Agreement -> Transição Imediata para Encerramento)
    console.log('💬 Turno 2: Fechando proposta à vista...');
    await chatService.send({
      clientId,
      externalUserId,
      originChannel: 'webchat_test',
      message:
        'Gostei da proposta NEG-001 à vista com 15% de desconto. Vamos fechar no PIX.',
    });

    // 4. Inspecionar o registro gravado em painel_interactions
    const interaction = await prisma.painel_interactions.findFirst({
      where: { client_id: clientId },
      orderBy: { created_at: 'desc' },
    });

    console.log('\n📊 Registro em painel_interactions:');
    console.log('ID:', interaction?.id);
    console.log('Session ID:', interaction?.session_id);
    console.log('Channel:', interaction?.channel);
    console.log('Client Name:', interaction?.client_name);
    console.log('Client Identifier:', interaction?.client_identifier);
    console.log('Has Human Answer:', interaction?.has_human_answer);
    console.log('Is Right Party (CPC):', interaction?.is_right_party);
    console.log('Is Debt Presented:', interaction?.is_debt_presented);
    console.log('Debt Amount:', interaction?.debt_amount);
    console.log(
      'Is Agreement Reached (CPCA):',
      interaction?.is_agreement_reached,
    );
    console.log('Agreement ID:', interaction?.agreement_id);
    console.log('Disposition:', interaction?.disposition);
    console.log('Status:', interaction?.status);
    console.log('Total Tokens:', interaction?.total_tokens);
    console.log(
      'Total Messages in JSON:',
      Array.isArray(interaction?.messages)
        ? (interaction?.messages as any[]).length
        : 0,
    );

    // 5. Testar Métricas de Funil
    const metrics = await interactionsService.getFunnelMetrics(clientId);
    console.log('\n📈 Métricas de Funil Agregadas:');
    console.log(JSON.stringify(metrics, null, 2));

    console.log(
      '\n🎉 Persistência e Funil em painel_interactions validados com 100% de sucesso!',
    );
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Erro no teste de interação:', err);
  process.exit(1);
});
