import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.id) throw new ForbiddenException('Acesso negado');

    const dbUser = await this.prisma.users.findUnique({
      where: { id: user.id },
      select: { role: true },
    });

    if (!dbUser || !requiredRoles.includes(dbUser.role)) {
      throw new ForbiddenException('Acesso negado: permissão insuficiente');
    }

    return true;
  }
}
