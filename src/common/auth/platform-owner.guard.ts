import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function isPlatformOwner(
  user:
    | { id?: string; role?: string; original_role?: string | null }
    | undefined,
  ownerId?: string,
): boolean {
  return (
    !!ownerId &&
    user?.id === ownerId &&
    user.role === 'platform_admin' &&
    !user.original_role
  );
}

@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      !isPlatformOwner(
        context.switchToHttp().getRequest().user,
        this.config.get<string>('PLATFORM_OWNER_USER_ID'),
      )
    ) {
      throw new ForbiddenException(
        'Acesso exclusivo do proprietário da plataforma.',
      );
    }
    return true;
  }
}
