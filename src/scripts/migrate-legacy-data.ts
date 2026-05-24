import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function migrateChannelConnections() {
  console.log('[Migration] painel_clients → channel_connections...');

  const clients = await prisma.painel_clients.findMany({
    where: {
      phone_number: { not: null },
    },
  });

  let created = 0;
  for (const client of clients) {
    const existing = await prisma.channel_connections.findFirst({
      where: { client_id: client.id, channel_type: 'whatsapp' },
    });

    if (!existing && client.phone_number) {
      await prisma.channel_connections.create({
        data: {
          company_id: client.company_id,
          client_id: client.id,
          channel_type: 'whatsapp',
          provider: 'evolution',
          provider_account_id: client.phone_number,
          status: 'active',
          config: {
            phone_number: client.phone_number,
            migrated_from: 'painel_clients',
          } as any,
        },
      });
      created++;
    }
  }

  console.log(`  ${created} channel_connections criadas`);
}

async function migrateSessions() {
  console.log('[Migration] orchestrator_sessions → conversation_state...');

  const sessions = await prisma.orchestrator_sessions.findMany();

  let migrated = 0;
  for (const session of sessions) {
    const state = session.session_state as Record<string, unknown> | null;
    if (!state) continue;

    const companyPhone = session.company_phone;
    const clientPhone = session.client_phone;

    const client = await prisma.painel_clients.findFirst({
      where: { phone_number: companyPhone },
    });

    if (!client) continue;

    const connection = await prisma.channel_connections.findFirst({
      where: { client_id: client.id, channel_type: 'whatsapp' },
    });

    if (!connection) continue;

    const endUser = await prisma.channel_identities.findFirst({
      where: { client_id: client.id, channel_type: 'whatsapp', external_user_id: clientPhone },
    });

    if (!endUser) continue;

    let conversation = await prisma.conversations.findFirst({
      where: {
        client_id: client.id,
        end_user_id: endUser.end_user_id,
        status: 'active',
      },
    });

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          company_id: client.company_id,
          client_id: client.id,
          channel_connection_id: connection.id,
          end_user_id: endUser.end_user_id,
          origin_channel: 'whatsapp',
          external_conversation_key: clientPhone,
          status: 'active',
          mode: 'auto',
        },
      });
    }

    const existingState = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversation.id },
    });

    if (!existingState) {
      const { sessionId, client_phone, company_phone, ...cleanState } = state as Record<string, unknown>;

      await prisma.conversation_state.create({
        data: {
          conversation_id: conversation.id,
          state: { ...cleanState, migrated_from_legacy: true } as any,
          version: 1,
        },
      });
      migrated++;
    }
  }

  console.log(`  ${migrated} conversas migradas`);
}

async function migrateChatMessages() {
  console.log('[Migration] orchestrator_chat_messages → messages + message_parts...');

  const sessions = await prisma.orchestrator_sessions.findMany();

  let migrated = 0;
  for (const session of sessions) {
    const state = session.session_state as Record<string, unknown> | null;
    if (!state) continue;

    const companyPhone = session.company_phone;
    const clientPhone = session.client_phone;

    const client = await prisma.painel_clients.findFirst({
      where: { phone_number: companyPhone },
    });

    if (!client) continue;

    const endUser = await prisma.channel_identities.findFirst({
      where: { client_id: client.id, channel_type: 'whatsapp', external_user_id: clientPhone },
    });

    if (!endUser) continue;

    const conversation = await prisma.conversations.findFirst({
      where: { client_id: client.id, end_user_id: endUser.end_user_id },
      orderBy: { created_at: 'desc' },
    });

    if (!conversation) continue;

    const chatMessages = await prisma.orchestrator_chat_messages.findMany({
      where: { session_id: (state as any).sessionId as string || '' },
      orderBy: { id: 'asc' },
    });

    for (const chatMsg of chatMessages) {
      const existing = await prisma.messages.findFirst({
        where: { conversation_id: conversation.id, content: chatMsg.content, sender_type: chatMsg.role === 'user' ? 'customer' : 'ai' },
      });

      if (!existing) {
        await prisma.messages.create({
          data: {
            company_id: client.company_id,
            conversation_id: conversation.id,
            sender_type: chatMsg.role === 'user' ? 'customer' : 'ai',
            channel: 'whatsapp',
            direction: chatMsg.role === 'user' ? 'inbound' : 'outbound',
            message_type: 'text',
            content: chatMsg.content,
            status: 'completed',
            created_at: chatMsg.created_at,
          },
        });
        migrated++;
      }
    }
  }

  console.log(`  ${migrated} mensagens migradas`);
}

async function main() {
  console.log('=== Legacy Data Migration ===\n');

  await migrateChannelConnections();
  console.log('');
  await migrateSessions();
  console.log('');
  await migrateChatMessages();

  console.log('\n=== Migration Complete ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
