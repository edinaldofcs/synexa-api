import { Module } from '@nestjs/common';
import { SubagentsService } from './subagents.service';
import { SubagentsController } from './subagents.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SubagentsController],
  providers: [SubagentsService],
  exports: [SubagentsService],
})
export class SubagentsModule {}
