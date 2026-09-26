import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ClientsController } from './clients.controller';
import { RolesGuard } from '../common/auth/roles.guard';

describe('provider configuration authorization', () => {
  const handler = ClientsController.prototype.saveLlmConfig;
  const guard = new RolesGuard(new Reflector());
  it.each(['platform_admin', 'company_admin', 'operator', 'user', undefined])(
    'authorizes only administrative writers (%s)',
    (role) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        RolesGuard,
      );
      const context = {
        getHandler: () => handler,
        getClass: () => ClientsController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { id: 'user', role } }),
        }),
      };
      if (role === 'platform_admin' || role === 'company_admin') {
        expect(guard.canActivate(context as never)).toBe(true);
      } else {
        expect(() => guard.canActivate(context as never)).toThrow(
          ForbiddenException,
        );
      }
    },
  );
});
