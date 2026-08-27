import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from './roles.decorator';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  function mockContext(roles: string[] | undefined, user: any) {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    guard = new RolesGuard(reflector);
  });

  it('should return true when no roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = mockContext(undefined, { id: '1', role: 'platform_admin' });

    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should return true when required roles array is empty', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    const ctx = mockContext([], { id: '1', role: 'platform_admin' });

    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should return true when user has the required role', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin']);
    const ctx = mockContext(['platform_admin'], {
      id: '1',
      role: 'platform_admin',
    });

    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user has insufficient role', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin']);
    const ctx = mockContext(['platform_admin'], { id: '1', role: 'operator' });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should return true when user has one of multiple required roles', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin', 'operator']);
    const ctx = mockContext(['platform_admin', 'operator'], {
      id: '1',
      role: 'operator',
    });

    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user is null', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin']);
    const ctx = mockContext(['platform_admin'], null);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when user is undefined', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin']);
    const ctx = mockContext(['platform_admin'], undefined);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should default user role to operator when role is not set', () => {
    reflector.getAllAndOverride.mockReturnValue(['operator']);
    const ctx = mockContext(['operator'], { id: '1' });

    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user has no id', () => {
    reflector.getAllAndOverride.mockReturnValue(['platform_admin']);
    const ctx = mockContext(['platform_admin'], { role: 'platform_admin' });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should call reflector with correct metadata key and targets', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    const ctx = mockContext([], { id: '1', role: 'platform_admin' });
    const handler = ctx.getHandler();
    const cls = ctx.getClass();

    guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      handler,
      cls,
    ]);
  });
});
