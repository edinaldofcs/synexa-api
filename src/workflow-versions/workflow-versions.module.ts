import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { WorkflowVersionsController } from './workflow-versions.controller';
import { WorkflowVersionsService } from './workflow-versions.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [WorkflowVersionsController],
  providers: [WorkflowVersionsService],
  exports: [WorkflowVersionsService],
})
export class WorkflowVersionsModule {}
