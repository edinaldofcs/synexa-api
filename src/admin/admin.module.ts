import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { LocalAdminService } from '../common/auth/local/local-admin.service';
import { SessionService } from '../common/auth/session.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, LocalAdminService, SessionService],
})
export class AdminModule {}
