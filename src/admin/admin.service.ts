import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SupabaseService } from '../common/supabase/supabase.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private supabase: SupabaseService,
  ) {}

  async createCompany(data: { name: string; cnpj: string; plan?: string }) {
    const { name, cnpj, plan = 'starter' } = data;

    if (!name) throw new BadRequestException('Name is required');

    try {
      const existingCompany = await this.prisma.companies.findFirst({
        where: { cnpj },
      });

      if (existingCompany) {
        return { success: true, company: existingCompany, existed: true };
      }

      const company = await this.prisma.companies.create({
        data: {
          name,
          cnpj,
          plan,
          status: 'active',
        },
      });

      return { success: true, company };
    } catch (err: unknown) {
      const error = err as Error;
      console.error('Create Company Error:', error);
      throw new InternalServerErrorException(error.message);
    }
  }

  async createUser(data: {
    email: string;
    password?: string;
    role?: string;
    company_id: string;
    name?: string;
  }) {
    const { email, password, role = 'operator', company_id, name } = data;

    if (!email || !company_id)
      throw new BadRequestException('Email and Company ID are required');

    try {
      let userId: string;

      // 1. Create Auth User
      const { data: authUser, error: authError } =
        await this.supabase.admin.auth.admin.createUser({
          email,
          password: password || undefined,
          email_confirm: true,
          user_metadata: { name: name || '' },
        });

      if (authError) {
        if (authError.message.includes('already registered')) {
          // Find existing user
          const listResult = await this.supabase.admin.auth.admin.listUsers();
          if (listResult.error) throw listResult.error;

          const usersList = listResult.data.users as Array<{
            id: string;
            email?: string;
          }>;
          const existingUser = usersList.find((u) => u.email === email);
          if (!existingUser)
            throw new Error('User reported existing but not found in list');
          userId = existingUser.id;
        } else {
          throw authError;
        }
      } else {
        if (!authUser || !authUser.user)
          throw new Error('User creation returned no data');
        userId = authUser.user.id;
      }

      // 2. Create Public Profile
      const existingProfile = await this.prisma.users.findUnique({
        where: { id: userId },
      });

      if (existingProfile) {
        return { success: true, user: existingProfile, existed: true };
      }

      const user = await this.prisma.users.create({
        data: {
          id: userId,
          company_id,
          role,
          name: name || '',
        },
      });

      return { success: true, user };
    } catch (err: unknown) {
      const error = err as Error;
      console.error('Create User Error:', error);
      throw new InternalServerErrorException(error.message);
    }
  }
}
