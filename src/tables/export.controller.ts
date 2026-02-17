import { Controller, Get, Param, Query } from '@nestjs/common';
import { TablesService } from './tables.service';

@Controller('export') // /api/export
export class ExportController {
    constructor(private readonly tablesService: TablesService) { }

    @Get(':tableName') // /api/export/:tableName
    async exportTable(@Param('tableName') tableName: string, @Query() params: any) {
        return this.tablesService.exportTable(tableName, params);
    }
}
