import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { LocalAdminService } from '../common/auth/local/local-admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, LocalAdminService],
})
export class AdminModule {}
