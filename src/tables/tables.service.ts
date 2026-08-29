import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  private readonly ALLOWED_TABLES = new Set([
    'painel_clients',
    'painel_agents',
    'painel_apis',
    'painel_tracks',
  ]);

  constructor(private prisma: PrismaService) {}

  async getTables() {
    try {
      const tables = await this.prisma.$queryRaw<TableResult[]>(Prisma.sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name IN (${Prisma.join([...this.ALLOWED_TABLES].map((t) => Prisma.sql`${t}`))})
        ORDER BY table_name;
      `);
      return { success: true, tables: tables.map((t) => t.table_name) };
    } catch (err: unknown) {
      const error = err as Error;
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async getTableSchema(tableName: string) {
    if (!this.ALLOWED_TABLES.has(tableName)) {
      throw new Error(`Table not allowed: ${tableName}`);
    }
    try {
      const schema = await this.prisma.$queryRaw<ColumnResult[]>(Prisma.sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name NOT IN ('id', 'created_at')
        ORDER BY ordinal_position;
      `);

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
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async exportTable(
    tableName: string,
    queryParams: { startDate?: string; endDate?: string },
  ) {
    const { startDate, endDate } = queryParams;

    const validName = /^[a-z_][a-z0-9_]*$/i;
    if (!validName.test(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    if (!this.ALLOWED_TABLES.has(tableName)) {
      throw new Error(`Table not allowed: ${tableName}`);
    }

    try {
      const [knownTable] = await this.prisma.$queryRaw<
        TableResult[]
      >(Prisma.sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND table_name NOT IN ('_prisma_migrations', 'Dummy')
      `);

      if (!knownTable) {
        throw new Error(`Table ${tableName} not found`);
      }

      const safeTableName = Prisma.raw(`"${knownTable.table_name}"`);

      let query = Prisma.sql`SELECT * FROM ${safeTableName}`;

      if (startDate && endDate) {
        query = Prisma.sql`${query} WHERE created_at BETWEEN ${new Date(startDate)} AND ${new Date(endDate)}`;
      } else if (startDate) {
        query = Prisma.sql`${query} WHERE created_at >= ${new Date(startDate)}`;
      } else if (endDate) {
        query = Prisma.sql`${query} WHERE created_at <= ${new Date(endDate)}`;
      }

      query = Prisma.sql`${query} ORDER BY created_at DESC`;

      const data = await this.prisma.$queryRaw<unknown[]>(query);
      return { success: true, data };
    } catch (err: unknown) {
      const error = err as Error;
      throw new InternalServerErrorException('Internal server error');
    }
  }
}
