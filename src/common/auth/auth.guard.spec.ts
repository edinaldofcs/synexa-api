import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './public.decorator';

const mockSuperCanActivate = jest.fn();

jest.mock('@nestjs/passport', () => ({
  AuthGuard: jest.fn().mockImplementation(() => {
    return class {
      canActivate(...args: any[]) {
        return mockSuperCanActivate(...args);
      }
    };
  }),
}));

import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    jest.clearAllMocks();

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    guard = new AuthGuard(reflector);
  });

  function mockContext() {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', headers: {} }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should return true when @Public() decorator is set on handler', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = mockContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockSuperCanActivate).not.toHaveBeenCalled();
  });

  it('should return true when @Public() decorator is set on class', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = mockContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockSuperCanActivate).not.toHaveBeenCalled();
  });

  it('should call super.canActivate and return true when not public', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    mockSuperCanActivate.mockResolvedValue(true);
    const ctx = mockContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockSuperCanActivate).toHaveBeenCalledWith(ctx);
  });

  it('should call super.canActivate and return false when not public and super returns false', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    mockSuperCanActivate.mockResolvedValue(false);
    const ctx = mockContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
    expect(mockSuperCanActivate).toHaveBeenCalledWith(ctx);
  });

  it('should check IS_PUBLIC_KEY metadata on both handler and class', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    mockSuperCanActivate.mockResolvedValue(true);
    const ctx = mockContext();

    await guard.canActivate(ctx);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });

  it('should authenticate a valid server-side session cookie', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const user = { id: 'user-1', role: 'operator', company_id: 'company-1' };
    const sessionService = {
      get: jest.fn().mockResolvedValue({ csrfToken: 'csrf-token', user }),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'ENVIRONMENT' ? 'development' : fallback,
      ),
    };
    const request: {
      method: string;
      headers: { cookie: string };
      user?: unknown;
    } = {
      method: 'GET',
      headers: { cookie: 'synexa_session=session-id' },
    };
    const ctx = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    guard = new AuthGuard(
      reflector,
      configService as any,
      undefined,
      sessionService as any,
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual(user);
  });

  it('should reject a state-changing session request without CSRF', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const sessionService = {
      get: jest.fn().mockResolvedValue({
        csrfToken: 'csrf-token',
        user: { id: 'user-1', role: 'operator', company_id: 'company-1' },
      }),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'ENVIRONMENT' ? 'development' : fallback,
      ),
    };
    const ctx = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          headers: { cookie: 'synexa_session=session-id' },
        }),
      }),
    } as unknown as ExecutionContext;
    guard = new AuthGuard(
      reflector,
      configService as any,
      undefined,
      sessionService as any,
    );

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'Proteção CSRF inválida',
    );
  });
});
