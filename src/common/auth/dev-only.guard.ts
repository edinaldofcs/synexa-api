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
    const environment = this.configService.get<string>(
      'ENVIRONMENT',
      'development',
    );
    if (environment === 'development') {
      return true;
    }
    throw new NotFoundException();
  }
}
