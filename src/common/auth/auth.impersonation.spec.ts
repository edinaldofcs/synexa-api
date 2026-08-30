import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { ROLES } from './roles.constants';
import type { SessionUser } from './session.service';

const platformAdmin: SessionUser = {
  id: 'admin-1',
  email: 'admin@synexa.com.br',
  name: 'Administrador Synexa',
  role: ROLES.PLATFORM_ADMIN,
  company_id: '00000000-0000-0000-0000-000000000001',
  company_name: 'Synexa Admin',
};

function buildService(
  company?: {
    id: string;
    name: string;
    status: string;
  } | null,
) {
  const prisma = {
    companies: {
      findUnique: jest.fn().mockResolvedValue(company ?? null),
    },
  };
  const service = new AuthService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

describe('AuthService impersonation', () => {
  it('platform_admin entra em visualização e ganha role company_admin da empresa alvo', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Empresa Beta',
      status: 'active',
    };
    const { service } = buildService(target);

    const result = await service.enterImpersonation(platformAdmin, target.id);

    expect(result.role).toBe(ROLES.COMPANY_ADMIN);
    expect(result.company_id).toBe(target.id);
    expect(result.company_name).toBe('Empresa Beta');
    expect(result.original_role).toBe(ROLES.PLATFORM_ADMIN);
    expect(result.original_company_id).toBe(platformAdmin.company_id);
    expect(result.original_company_name).toBe('Synexa Admin');
  });

  it('rejeita usuário que não é platform_admin', async () => {
    const { service } = buildService({
      id: 'x',
      name: 'X',
      status: 'active',
    });

    await expect(
      service.enterImpersonation(
        { ...platformAdmin, role: ROLES.COMPANY_ADMIN },
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('não permite impersonação aninhada', async () => {
    const { service } = buildService({
      id: 'x',
      name: 'X',
      status: 'active',
    });
    const viewing = { ...platformAdmin, original_role: ROLES.PLATFORM_ADMIN };

    await expect(
      service.enterImpersonation(
        viewing,
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('empresa inexistente retorna NotFound', async () => {
    const { service } = buildService(null);

    await expect(
      service.enterImpersonation(
        platformAdmin,
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('empresa suspensa é bloqueada', async () => {
    const { service } = buildService({
      id: 'x',
      name: 'Suspensa',
      status: 'suspended',
    });

    await expect(
      service.enterImpersonation(
        platformAdmin,
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('exit restaura identidade real e limpa campos de visualização', () => {
    const { service } = buildService();
    const viewing: SessionUser = {
      ...platformAdmin,
      role: ROLES.COMPANY_ADMIN,
      company_id: '22222222-2222-4222-8222-222222222222',
      company_name: 'Empresa Beta',
      original_role: ROLES.PLATFORM_ADMIN,
      original_company_id: platformAdmin.company_id,
      original_company_name: 'Synexa Admin',
    };

    const restored = service.exitImpersonation(viewing);

    expect(restored.role).toBe(ROLES.PLATFORM_ADMIN);
    expect(restored.company_id).toBe(platformAdmin.company_id);
    expect(restored.original_role).toBeUndefined();
    expect(restored.original_company_id).toBeUndefined();
    expect(restored.original_company_name).toBeUndefined();
  });

  it('exit sem visualização ativa é rejeitado', () => {
    const { service } = buildService();

    expect(() => service.exitImpersonation(platformAdmin)).toThrow(
      BadRequestException,
    );
  });

  it('checagem de papel usa request.user (actor): rebaixado não impersona mesmo com sessão stale', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Empresa Beta',
      status: 'active',
    };
    const { service } = buildService(target);
    const demoted = { ...platformAdmin, role: ROLES.OPERATOR };

    await expect(
      service.enterImpersonation(platformAdmin, target.id, demoted),
    ).rejects.toThrow(ForbiddenException);
  });

  it('actor já impersonando (original_role recarregado) mantém bloqueio de visualização aninhada', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Empresa Beta',
      status: 'active',
    };
    const { service } = buildService(target);
    const viewingActor: SessionUser = {
      ...platformAdmin,
      role: ROLES.COMPANY_ADMIN,
      company_id: '22222222-2222-4222-8222-222222222222',
      company_name: 'Empresa Beta',
      original_role: ROLES.PLATFORM_ADMIN,
      original_company_id: platformAdmin.company_id,
      original_company_name: 'Synexa Admin',
    };

    await expect(
      service.enterImpersonation(viewingActor, target.id, viewingActor),
    ).rejects.toThrow(BadRequestException);
  });

  it('define impersonating_until (60min) ao entrar na visualização', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Empresa Beta',
      status: 'active',
    };
    const { service } = buildService(target);

    const result = await service.enterImpersonation(platformAdmin, target.id);

    expect(result.impersonating_until).toBeGreaterThan(Date.now());
    expect(result.impersonating_until).toBeLessThanOrEqual(
      Date.now() + 60 * 60 * 1000,
    );
  });
});
