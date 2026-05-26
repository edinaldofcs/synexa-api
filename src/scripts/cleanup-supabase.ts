import { Client } from 'pg';

const directUrl =
  process.env.DIRECT_URL ||
  `postgresql://postgres.tpkuwyfzqsdbfiwmtxcn:${process.env.DB_PASS_SUPABASE || ''}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;

async function cleanup() {
  const client = new Client({ connectionString: directUrl });
  await client.connect();

  console.log('Connected to Supabase DB\n');

  const deprecatedTables = [
    'orchestrator_sessions',
    'orchestrator_chat_messages',
    'painel_agents',
    'painel_apis',
    'painel_intentions',
    'imports',
    'contacts',
    'people_phones',
    'people',
    'phones',
    'debts',
  ];

  for (const table of deprecatedTables) {
    console.log(`Dropping ${table}...`);
    try {
      await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      console.log(`  OK`);
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
  }

  console.log('\nEnsuring enterprise tables exist...');
  const requiredTables = [
    'companies',
    'users',
    'channel_connections',
    'webhook_endpoints',
    'webhook_deliveries',
    'end_users',
    'channel_identities',
    'conversations',
    'messages',
    'message_parts',
    'conversation_state',
    'media_assets',
    'inbound_events',
    'outbox_events',
    'message_events',
    'agent_runs',
    'tool_calls',
    'knowledge_bases',
    'knowledge_documents',
    'knowledge_chunks',
    'knowledge_embeddings',
  ];

  for (const table of requiredTables) {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
      [table],
    );
    console.log(`  ${table}: ${rows[0].exists ? 'OK' : 'MISSING'}`);
  }

  await client.end();
  console.log('\nDone');
}

cleanup().catch(console.error);
