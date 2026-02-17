import { Module } from '@nestjs/common';
import { TablesService } from './tables.service';
import { TablesController } from './tables.controller';
import { ExportController } from './export.controller';

@Module({
  controllers: [TablesController, ExportController],
  providers: [TablesService],
})
export class TablesModule {}
