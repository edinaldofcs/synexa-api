import { DevOnlyGuard } from './dev-only.guard';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, NotFoundException } from '@nestjs/common';

describe('DevOnlyGuard', () => {
  let guard: DevOnlyGuard;
  let configService: jest.Mocked<ConfigService>;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    guard = new DevOnlyGuard(configService);

    mockContext = {} as ExecutionContext;
  });

  it('should return true when environment is development', () => {
    configService.get.mockReturnValue('development');

    const result = guard.canActivate(mockContext);
    expect(result).toBe(true);
    expect(configService.get).toHaveBeenCalledWith(
      'ENVIRONMENT',
      'development',
    );
  });

  it('should throw NotFoundException when environment is production', () => {
    configService.get.mockReturnValue('production');

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('should throw NotFoundException when environment is staging', () => {
    configService.get.mockReturnValue('staging');

    expect(() => guard.canActivate(mockContext)).toThrow(NotFoundException);
  });

  it('should return true when environment is missing from config (uses default development)', () => {
    configService.get.mockImplementation(
      (_key: string, defaultValue: any) => defaultValue,
    );

    const result = guard.canActivate(mockContext);
    expect(result).toBe(true);
  });
});
