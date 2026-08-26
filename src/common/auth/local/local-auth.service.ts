import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LocalAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUser(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        role: true,
        company_id: true,
        companies: { select: { status: true } },
      },
    });

    if (!user || user.companies.status !== 'active') {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    return user;
  }
}
