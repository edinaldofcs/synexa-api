import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { ImportsModule } from './imports/imports.module';
import { AdminModule } from './admin/admin.module';
import { TablesModule } from './tables/tables.module';
import { ChatModule } from './chat/chat.module';
import { PainelClientsModule } from './painel-clients/painel-clients.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    ImportsModule,
    AdminModule,
    TablesModule,
    TablesModule,
    ChatModule,
    PainelClientsModule,
  ],
})
export class AppModule { }
