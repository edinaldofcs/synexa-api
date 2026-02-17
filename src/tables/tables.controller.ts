import { Controller, Get, Param, Query } from '@nestjs/common';
import { TablesService } from './tables.service';

@Controller('tables') // /api/tables
export class TablesController {
    constructor(private readonly tablesService: TablesService) { }

    @Get()
    async getTables() {
        return this.tablesService.getTables();
    }

    @Get(':tableName/schema') // /api/tables/:tableName/schema
    async getTableSchema(@Param('tableName') tableName: string) {
        return this.tablesService.getTableSchema(tableName);
    }

    // Actually, schema uses /api/tables/:tableName/schema
    // But export uses /api/export/:tableName.
    // I should use `export` controller? Or just put it here with a different path?
    // In Nest, `@Controller('export')` for another controller, or here `@Get('/export/:tableName')` inside `TablesController`?
    // Nest routes are relative to Controller prefix.
    // So if I want `/api/export`, I need a separate controller or override route.
    // `@Get('../export/:tableName')` works? No.
    // I'll create `ExportController` inside `TablesModule`?
    // Or just use `@Controller('')` and manage paths manually? No, bad pattern.
    // I'll add `ExportController` to `TablesModule` separately.
}
