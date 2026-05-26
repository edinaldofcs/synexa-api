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
});
