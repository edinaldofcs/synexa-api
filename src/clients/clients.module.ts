import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AgentsModule } from '../agents/agents.module';
import { ApisModule } from '../apis/apis.module';
import { IntentionsModule } from '../intentions/intentions.module';
import { ClientsController } from './clients.controller';
import { ClientsRepository } from './repositories/clients.repository';
import { ClientsService } from './clients.service';

@Module({
  imports: [CommonModule, AgentsModule, ApisModule, IntentionsModule],
  controllers: [ClientsController],
  providers: [ClientsService, ClientsRepository],
  exports: [ClientsService, ClientsRepository],
})
export class ClientsModule {}
