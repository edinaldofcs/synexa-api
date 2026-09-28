import { MediaModule } from '../media/media.module';
import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { LocalAdminService } from '../common/auth/local/local-admin.service';
import { SessionService } from '../common/auth/session.service';
import {
  PartnersController,
  PartnerActivationController,
} from './partners.controller';
import { PartnersService } from './partners.service';
import { PlatformOwnerGuard } from '../common/auth/platform-owner.guard';

@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [
    AdminController,
    PartnersController,
    PartnerActivationController,
  ],
  providers: [
    AdminService,
    LocalAdminService,
    SessionService,
    PartnersService,
    PlatformOwnerGuard,
  ],
})
export class AdminModule {}
