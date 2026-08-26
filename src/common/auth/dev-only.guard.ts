import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DevOnlyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    // Explicit process configuration must win in tests and container runtimes.
    const environment =
      process.env.ENVIRONMENT || this.configService.get<string>('ENVIRONMENT');
    if (environment === 'development') {
      return true;
    }
    throw new NotFoundException();
  }
}
