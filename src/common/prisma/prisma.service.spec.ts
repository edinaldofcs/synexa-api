import {
  applyTenantInjection,
  TENANT_SUPPORTED_MODELS,
} from './prisma.service';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';

describe('applyTenantInjection', () => {
  it('covers every model that has company_id in schema.prisma (except companies)', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    const modelsWithCompanyId: string[] = [];
    let current: string | null = null;
    for (const line of schema.split('\n')) {
      if (current && /^\}/.test(line)) {
        current = null;
        continue;
      }
      if (current && line.includes('company_id')) {
        modelsWithCompanyId.push(current);
        continue;
      }
      const m = line.match(/^model (\w+) \{/);
      if (m) current = m[1];
    }

    const missing = modelsWithCompanyId.filter(
      (m) => !TENANT_SUPPORTED_MODELS.includes(m),
    );
    // Todos os modelos com coluna company_id devem estar cobertos pelo escopo de tenant
    expect(modelsWithCompanyId.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('injects company_id into where for previously unscoped models (regression)', () => {
    for (const model of [
      'credential_audit_logs',
      'provider_credentials',
      'business_events',
      'painel_interactions',
      'voice_session_telemetry',
      'telephony_endpoints',
    ]) {
      const args: any = { where: { status: 'active' } };
      applyTenantInjection(model, 'findMany', args, COMPANY_ID);
      expect(args.where.company_id).toBe(COMPANY_ID);
    }
  });

  it('overrides where.company_id coming from caller (defense in depth)', () => {
    const args: any = { where: { company_id: 'other-company' } };
    applyTenantInjection('provider_credentials', 'findMany', args, COMPANY_ID);
    expect(args.where.company_id).toBe(COMPANY_ID);
  });

  it('injects company_id into create data for scoped models', () => {
    const args: any = { data: { provider: 'gemini' } };
    applyTenantInjection('provider_credentials', 'create', args, COMPANY_ID);
    expect(args.data.company_id).toBe(COMPANY_ID);
  });

  it('injects company_id into each item of createMany', () => {
    const args: any = { data: [{ a: 1 }, { b: 2 }] };
    applyTenantInjection(
      'credential_audit_logs',
      'createMany',
      args,
      COMPANY_ID,
    );
    expect(args.data).toEqual([
      { a: 1, company_id: COMPANY_ID },
      { b: 2, company_id: COMPANY_ID },
    ]);
  });

  it('does nothing without tenant context (worker/voice/queue)', () => {
    const args: any = { where: { id: 'x' } };
    const result = applyTenantInjection(
      'telephony_endpoints',
      'findUnique',
      args,
      undefined,
    );
    expect(result.where).toEqual({ id: 'x' });
  });

  it('does nothing for models without company_id column', () => {
    const args: any = { where: { id: 'x' } };
    applyTenantInjection('painel_agents', 'findMany', args, COMPANY_ID);
    expect(args.where.company_id).toBeUndefined();
  });

  it('forces tenant on findUnique by id (blocks cross-tenant by-id access)', () => {
    const args: any = { where: { id: 'target-id' } };
    applyTenantInjection('telephony_endpoints', 'delete', args, COMPANY_ID);
    expect(args.where).toEqual({
      id: 'target-id',
      company_id: COMPANY_ID,
    });
  });
});
