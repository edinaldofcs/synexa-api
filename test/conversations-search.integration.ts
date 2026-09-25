/** Run against a disposable PostgreSQL: TEST_DATABASE_URL=... node -r ts-node/register/transpile-only test/conversations-search.integration.ts */
import { strict as assert } from 'assert';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { ConversationsService } from '../src/conversations/conversations.service';

async function main() {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL is required');
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    // Session-local tables: never modify existing project tables.
    await db.query(`
      CREATE TEMP TABLE conversations (id uuid, company_id uuid, client_id uuid, end_user_id uuid,
        status text, origin_channel text, last_message_at timestamptz, created_at timestamptz, metadata jsonb);
      CREATE TEMP TABLE conversation_state (conversation_id uuid, state jsonb);
      CREATE TEMP TABLE end_users (id uuid, name text, metadata jsonb);
      CREATE TEMP TABLE painel_clients (id uuid, company_name text);
      CREATE TEMP TABLE messages (id uuid, conversation_id uuid, content text, created_at timestamptz);
    `);
    const company = randomUUID(),
      other = randomUUID(),
      client = randomUUID(),
      person = randomUUID();
    const ids = Array.from({ length: 201 }, () => randomUUID());
    await db.query('INSERT INTO end_users VALUES ($1, $2, $3)', [
      person,
      'Customer',
      '{}',
    ]);
    await db.query('INSERT INTO painel_clients VALUES ($1, $2)', [
      client,
      'Client',
    ]);
    for (let i = 0; i < ids.length; i++) {
      await db.query(
        'INSERT INTO conversations VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)',
        [
          ids[i],
          company,
          client,
          person,
          i % 2 ? 'closed' : 'active',
          'voice',
          new Date(Date.UTC(2026, 0, i + 1)),
          '{}',
        ],
      );
    }
    await db.query(
      'INSERT INTO conversations VALUES ($1,$2,$3,$4,$5,$6,now(),now(),$7)',
      [randomUUID(), other, client, person, 'active', 'voice', '{}'],
    );
    await db.query('INSERT INTO conversation_state VALUES ($1,$2)', [
      ids[0],
      JSON.stringify({ state: { acordo: true, cpc: 'sim' } }),
    ]);
    await db.query('INSERT INTO messages VALUES ($1,$2,$3,now())', [
      randomUUID(),
      ids[0],
      'old searchable message',
    ]);
    const prisma = {
      $queryRaw: async (sql: any) =>
        (await db.query(sql.text, sql.values)).rows,
      conversations: {
        findMany: async (args: any) =>
          args.where.id.in.map((id: string) => ({ id })),
      },
    };
    const service = new ConversationsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const first = await service.searchConversations(company, {
      page: 1,
      limit: 50,
    });
    assert.equal(first.total, 201);
    assert.deepEqual(first.counts, {
      active: 101,
      closed: 100,
      deals: 1,
      cpc: 1,
    });
    const last = await service.searchConversations(company, {
      page: 5,
      limit: 50,
    });
    assert.deepEqual(
      last.data.map((row) => row.id),
      [ids[0]],
    );
    const deals = await service.searchConversations(company, {
      filter: 'deals',
      page: 1,
      limit: 50,
    });
    assert.deepEqual(
      deals.data.map((row) => row.id),
      [ids[0]],
    );
    const search = await service.searchConversations(company, {
      search: 'old searchable',
      page: 1,
      limit: 50,
    });
    assert.equal(search.total, 1);
    assert.equal(
      (
        await service.searchConversations(company, {
          search: "' OR TRUE --",
          page: 1,
          limit: 50,
        })
      ).total,
      0,
    );
    assert.equal(
      (
        await service.searchConversations(company, {
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-01-01T23:59:59.999Z',
          page: 1,
          limit: 50,
        })
      ).total,
      1,
    );
    assert.equal(
      (
        await service.searchConversations(company, {
          channel: 'api',
          page: 1,
          limit: 50,
        })
      ).total,
      0,
    );
    console.log(
      'PASS: pagination beyond 150, tenant isolation, counts, outcomes, date/channel/search filters, SQL parameterization',
    );
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
