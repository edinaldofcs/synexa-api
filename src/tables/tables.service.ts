import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class TablesService {
    constructor(private prisma: PrismaService) { }

    async getTables() {
        try {
            const tables: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name NOT IN ('_prisma_migrations', 'Dummy')
        ORDER BY table_name;
      `);
            return { success: true, tables: tables.map((t) => t.table_name) };
        } catch (err: any) {
            throw new InternalServerErrorException(err.message);
        }
    }

    async getTableSchema(tableName: string) {
        try {
            const schema: any[] = await this.prisma.$queryRawUnsafe(
                `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name NOT IN ('id', 'created_at')
        ORDER BY ordinal_position;
      `,
                tableName,
            );

            const mappedSchema = schema.map((col) => {
                let type = 'string';
                const pgType = col.data_type.toLowerCase();

                if (
                    pgType.includes('numeric') ||
                    pgType.includes('integer') ||
                    pgType.includes('double') ||
                    pgType.includes('real')
                ) {
                    type = 'number';
                } else if (pgType.includes('boolean')) {
                    type = 'boolean';
                } else if (pgType.includes('timestamp') || pgType.includes('date')) {
                    type = 'date';
                }

                return {
                    name: col.column_name,
                    type,
                    required: col.is_nullable === 'NO',
                };
            });

            return { success: true, schema: mappedSchema };
        } catch (err: any) {
            throw new InternalServerErrorException(err.message);
        }
    }

    async exportTable(tableName: string, queryParams: { startDate?: string; endDate?: string }) {
        const { startDate, endDate } = queryParams;
        try {
            // Validate table name to prevent SQL injection (basic check, ideally check against getTables list)
            // Since $queryRawUnsafe is used for table name which cannot be parameterized easily in all drivers (though Postgres supports identifier param?)
            // Prisma doesn't support identifier params in queryRaw.
            // We really should be careful here. Assuming internal use/admin.
            // Better: Quote identifier.
            const safeTableName = `"${tableName.replace(/"/g, '""')}"`;

            let query = `SELECT * FROM ${safeTableName}`;
            const params: any[] = [];

            if (startDate && endDate) {
                query += ` WHERE created_at BETWEEN $1 AND $2`;
                params.push(new Date(startDate), new Date(endDate));
            } else if (startDate) {
                query += ` WHERE created_at >= $1`;
                params.push(new Date(startDate));
            } else if (endDate) {
                query += ` WHERE created_at <= $1`;
                params.push(new Date(endDate));
            }

            query += ` ORDER BY created_at DESC`;

            const data = await this.prisma.$queryRawUnsafe(query, ...params);
            return { success: true, data };
        } catch (err: any) {
            throw new InternalServerErrorException(err.message);
        }
    }
}
