import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { AgentsController } from './agents.controller';
import { AgentsRepository } from './repositories/agents.repository';
import { AgentsService } from './agents.service';

@Module({
  imports: [CommonModule, OrchestratorModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentsRepository],
  exports: [AgentsService, AgentsRepository],
})
export class AgentsModule {}
