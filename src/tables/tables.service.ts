import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

interface TableResult {
  table_name: string;
}

interface ColumnResult {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

@Injectable()
export class TablesService {
  constructor(private prisma: PrismaService) {}

  async getTables() {
    try {
      const tables = await this.prisma.$queryRawUnsafe<TableResult[]>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name NOT IN ('_prisma_migrations', 'Dummy')
        ORDER BY table_name;
      `);
      return { success: true, tables: tables.map((t) => t.table_name) };
    } catch (err: unknown) {
      const error = err as Error;
      throw new InternalServerErrorException(error.message);
    }
  }

  async getTableSchema(tableName: string) {
    try {
      const schema = await this.prisma.$queryRawUnsafe<ColumnResult[]>(
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
    } catch (err: unknown) {
      const error = err as Error;
      throw new InternalServerErrorException(error.message);
    }
  }

  async exportTable(
    tableName: string,
    queryParams: { startDate?: string; endDate?: string },
  ) {
    const { startDate, endDate } = queryParams;
    try {
      const safeTableName = `"${tableName.replace(/"/g, '""')}"`;

      let query = `SELECT * FROM ${safeTableName}`;
      const params: unknown[] = [];

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

      const data = await this.prisma.$queryRawUnsafe<unknown[]>(
        query,
        ...params,
      );
      return { success: true, data };
    } catch (err: unknown) {
      const error = err as Error;
      throw new InternalServerErrorException(error.message);
    }
  }
}
