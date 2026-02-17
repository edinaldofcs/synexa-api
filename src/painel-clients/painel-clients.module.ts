import { Module } from '@nestjs/common';
import { PainelClientsService } from './painel-clients.service';
import { PainelClientsController } from './painel-clients.controller';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [PainelClientsController],
    providers: [PainelClientsService],
})
export class PainelClientsModule { }
