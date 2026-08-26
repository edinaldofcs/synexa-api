import { Module } from '@nestjs/common';
import { InteractionsService } from './interactions.service';
import { InteractionsController } from './interactions.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuthModule } from '../common/auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [InteractionsController],
  providers: [InteractionsService],
  exports: [InteractionsService],
})
export class InteractionsModule {}
