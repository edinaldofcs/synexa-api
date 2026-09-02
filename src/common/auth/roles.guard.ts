import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.id) throw new ForbiddenException('Acesso negado');

    // Fail-closed: role ausente no usuário autenticado nunca recebe privilégio por omissão
    if (!user.role) {
      throw new ForbiddenException(
        'Acesso negado: papel do usuário indefinido',
      );
    }

    const userRole = user.role;

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException('Acesso negado: permissão insuficiente');
    }

    return true;
  }
}
