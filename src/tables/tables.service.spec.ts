import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TablesService } from './tables.service';

describe('TablesService - tenant isolation on exportTable', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  const service = new TablesService(prisma as never);
  const companyId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      // primeira chamada: checagem information_schema; segunda: dados
      if (query.sql.includes('information_schema')) {
        return [{ table_name: query.values[0] }];
      }
      return [];
    });
  });

  it('rejects export when tenant is not identified', async () => {
    await expect(
      service.exportTable('painel_clients', {}, undefined as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects tables outside the allowlist', async () => {
    await expect(
      service.exportTable('companies', {}, companyId),
    ).rejects.toBeInstanceOf(Error);
  });

  it('filters painel_clients by company_id', async () => {
    await service.exportTable('painel_clients', {}, companyId);

    const dataQuery = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(dataQuery.sql).toContain('"painel_clients"');
    expect(dataQuery.sql).toContain('company_id = ?');
    expect(dataQuery.sql).not.toContain('SELECT id FROM');
    expect(dataQuery.values).toContain(companyId);
  });

  it('scopes client-scoped tables via client_id subquery on company', async () => {
    await service.exportTable('painel_apis', {}, companyId);

    const dataQuery = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(dataQuery.sql).toContain('"painel_apis"');
    expect(dataQuery.sql).toContain(
      'client_id IN (SELECT id FROM "painel_clients"',
    );
    expect(dataQuery.sql).toContain('company_id = ?');
    expect(dataQuery.values).toContain(companyId);
  });

  it('combines tenant filter with date range using AND', async () => {
    await service.exportTable(
      'painel_clients',
      { startDate: '2026-01-01', endDate: '2026-02-01' },
      companyId,
    );

    const dataQuery = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(dataQuery.sql).toContain('WHERE');
    expect(dataQuery.sql).toContain('company_id = ?');
    expect(dataQuery.sql).toContain('AND created_at BETWEEN ? AND ?');
  });

  it('never returns unfiltered SELECT *', async () => {
    await service.exportTable('painel_tracks', {}, companyId);

    const dataQuery = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(dataQuery.sql).toMatch(/SELECT \* FROM "painel_tracks" WHERE/);
  });
});
