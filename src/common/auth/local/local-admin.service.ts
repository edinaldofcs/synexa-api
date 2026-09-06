import {
  Injectable,
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LocalAdminService {
  private readonly logger = new Logger(LocalAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: {
    email: string;
    password?: string;
    role?: string;
    company_id: string;
    name?: string;
  }) {
    const { email, password, role = 'operator', company_id, name } = data;

    if (!email || !company_id) {
      throw new BadRequestException('Email e Company ID são obrigatórios');
    }

    try {
      const existingUser = await this.prisma.users.findUnique({
        where: { email },
      });

      if (existingUser) {
        if (existingUser.company_id !== company_id) {
          throw new ConflictException(
            'Este e-mail já está cadastrado para outra empresa no sistema. Por favor, utilize outro e-mail.',
          );
        }
        return { success: true, user: existingUser, existed: true };
      }

      const userId = randomUUID();
      const password_hash = password ? await bcrypt.hash(password, 10) : null;

      const user = await this.prisma.users.create({
        data: {
          id: userId,
          company_id,
          role,
          name: name || email,
          email,
          password_hash,
        },
      });

      return { success: true, user };
    } catch (err: unknown) {
      if (err instanceof HttpException) throw err;
      const error = err as Error;
      this.logger.error('Create User Error:', error);
      throw new InternalServerErrorException('Internal server error');
    }
  }
}
