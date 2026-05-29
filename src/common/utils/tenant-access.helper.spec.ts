import { ForbiddenException } from '@nestjs/common';
import {
  extractTenantContext,
  assertTenantAccess,
  applyTenantFilter,
} from './tenant-access.helper';

describe('tenant-access.helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractTenantContext', () => {
    it('should extract userId, companyId, and role from full user object', () => {
      const user = { id: 'user-1', company_id: 'company-1', role: 'admin' };
      expect(extractTenantContext(user)).toEqual({
        userId: 'user-1',
        companyId: 'company-1',
        role: 'admin',
      });
    });

    it('should use sub as userId when id is not present', () => {
      const user = {
        sub: 'sub-user-1',
        company_id: 'company-1',
        role: 'admin',
      };
      expect(extractTenantContext(user)).toEqual({
        userId: 'sub-user-1',
        companyId: 'company-1',
        role: 'admin',
      });
    });

    it('should prefer id over sub when both are present', () => {
      const user = { id: 'id-user', sub: 'sub-user', company_id: 'company-1' };
      expect(extractTenantContext(user).userId).toBe('id-user');
    });

    it('should return companyId as null when company_id is not present', () => {
      const user = { id: 'user-1' };
      expect(extractTenantContext(user)).toEqual({
        userId: 'user-1',
        companyId: null,
        role: 'operator',
      });
    });

    it('should default role to operator when not present', () => {
      const user = { id: 'user-1', company_id: 'company-1' };
      expect(extractTenantContext(user).role).toBe('operator');
    });

    it('should throw ForbiddenException when user is null', () => {
      expect(() => extractTenantContext(null)).toThrow(ForbiddenException);
      expect(() => extractTenantContext(null)).toThrow(
        'Acesso negado: usuário não autenticado',
      );
    });

    it('should throw ForbiddenException when user is undefined', () => {
      expect(() => extractTenantContext(undefined)).toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when user has no id or sub', () => {
      const user = { role: 'admin' };
      expect(() => extractTenantContext(user)).toThrow(ForbiddenException);
      expect(() => extractTenantContext(user)).toThrow(
        'Acesso negado: ID do usuário não encontrado no token',
      );
    });
  });

  describe('assertTenantAccess', () => {
    it('should not throw when company IDs match', () => {
      expect(() => assertTenantAccess('company-1', 'company-1')).not.toThrow();
    });

    it('should throw ForbiddenException when company IDs mismatch', () => {
      expect(() => assertTenantAccess('company-1', 'company-2')).toThrow(
        ForbiddenException,
      );
      expect(() => assertTenantAccess('company-1', 'company-2')).toThrow(
        'Acesso negado: tenant mismatch',
      );
    });

    it('should throw when userCompanyId is null and resourceCompanyId is a string', () => {
      expect(() => assertTenantAccess(null as any, 'company-1')).toThrow(
        ForbiddenException,
      );
    });

    it('should throw when resourceCompanyId is undefined', () => {
      expect(() => assertTenantAccess('company-1', undefined as any)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('applyTenantFilter', () => {
    it('should return an object with company_id', () => {
      expect(applyTenantFilter('company-1')).toEqual({
        company_id: 'company-1',
      });
    });

    it('should return company_id as null when given null', () => {
      expect(applyTenantFilter(null as any)).toEqual({ company_id: null });
    });

    it('should return company_id as undefined when given undefined', () => {
      expect(applyTenantFilter(undefined as any)).toEqual({ company_id: undefined });
    });
  });
});
