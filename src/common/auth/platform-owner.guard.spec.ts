import { PlatformOwnerGuard } from './platform-owner.guard';
import { ForbiddenException } from '@nestjs/common';

describe('PlatformOwnerGuard', () => {
  const context = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
  const guard = new PlatformOwnerGuard({ get: () => 'owner-id' } as any);
  it('permite somente a conta configurada com papel da plataforma', () => {
    expect(
      guard.canActivate(context({ id: 'owner-id', role: 'platform_admin' })),
    ).toBe(true);
  });
  it.each([
    undefined,
    { id: 'other-admin', role: 'platform_admin' },
    { id: 'owner-id', role: 'company_admin' },
    { id: 'owner-id', role: 'platform_admin', original_role: 'platform_admin' },
  ])(
    'recusa conta diferente, papel insuficiente ou visualização de empresa',
    (user) => {
      expect(() => guard.canActivate(context(user))).toThrow(
        ForbiddenException,
      );
    },
  );
  it('nega acesso quando o proprietário não foi configurado', () => {
    const unset = new PlatformOwnerGuard({ get: () => undefined } as any);
    expect(() =>
      unset.canActivate(context({ id: 'owner-id', role: 'platform_admin' })),
    ).toThrow(ForbiddenException);
  });
});
