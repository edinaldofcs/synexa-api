import { Client } from 'pg';

const directUrl =
  process.env.DIRECT_URL ||
  `postgresql://postgres.tpkuwyfzqsdbfiwmtxcn:${process.env.DB_PASS_SUPABASE || ''}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;

async function main() {
  const client = new Client({ connectionString: directUrl });
  await client.connect();
  console.log('Connected');

  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  console.log('vector extension OK');

  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  console.log('pgcrypto extension OK');

  await client.end();
  console.log('Done');
}

main().catch(console.error);
