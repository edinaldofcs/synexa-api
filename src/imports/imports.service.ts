import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImportContactsDto } from './dto/import-contact.dto';
import { Prisma } from '@prisma/client';

interface ContactRow {
  cpf?: string | number;
  documento?: string | number;
  name?: string;
  nome?: string;
  email?: string;
  birth_date?: string | number | Date;
  phone_number?: string | number;
  phone?: string | number;
  telefone?: string | number;
  celular?: string | number;
  is_primary?: string | boolean;
  original_amount?: string | number;
  current_amount?: string | number;
  due_date?: string | number | Date;
  contract_number?: string | number;
  status?: string;
  portfolio?: string;
  product_type?: string;
  segment?: string;
  negotiation_limit?: string | number;
  discount_limit?: string | number;
  [key: string]: any;
}

@Injectable()
export class ImportsService {
  constructor(private prisma: PrismaService) {}

  async importContacts(dto: ImportContactsDto) {
    const { userId, fileName, fileType = 'csv', data } = dto;

    if (!data.length) {
      throw new BadRequestException('Data array is empty');
    }

    try {
      // 1. Resolve Company from User
      const user = await this.prisma.users.findUnique({
        where: { id: userId },
      });

      if (!user?.company_id) {
        throw new BadRequestException(
          'Invalid User ID or User has no Company assigned.',
        );
      }

      const companyId = user.company_id;

      // 2. Create Import Record
      const importRecord = await this.prisma.imports.create({
        data: {
          company_id: companyId,
          file_name: fileName || 'upload.csv',
          file_type: fileType,
          total_records: data.length,
          status: 'processing',
        },
      });

      const importId = importRecord.id;

      // 3. Insert Raw Data into Contacts (Staging)
      const contactsData = data.map((row) => ({
        company_id: companyId,
        import_id: importId,
        raw_data: row as unknown as Prisma.InputJsonValue,
        status: 'pending',
      }));

      // Insert in batches
      const batchSize = 1000;
      for (let i = 0; i < contactsData.length; i += batchSize) {
        const batch = contactsData.slice(i, i + batchSize);
        await this.prisma.contacts.createMany({
          data: batch,
        });
      }

      // 4. Trigger Async Processing
      void this.processImport(importId, companyId).catch((err: unknown) =>
        console.error(
          `Background processing failed for import ${importId}:`,
          err,
        ),
      );

      return {
        success: true,
        importId,
        message: `Importação iniciada. ${data.length} registros na fila de processamento.`,
      };
    } catch (err: unknown) {
      const error = err as Error;
      console.error('Import Error:', error);
      throw new InternalServerErrorException(
        `Erro no processamento: ${error.message}`,
      );
    }
  }

  private async processImport(importId: string, companyId: string) {
    console.log(`Starting processing for import ${importId}`);

    const pendingContacts = await this.prisma.contacts.findMany({
      where: { import_id: importId, status: 'pending' },
    });

    let validCount = 0;
    let invalidCount = 0;
    const errorLog: { id: string; error: string }[] = [];

    for (const contact of pendingContacts) {
      try {
        const raw = (contact.raw_data ?? {}) as ContactRow;
        const row: ContactRow = {};
        // Normalize keys
        Object.keys(raw).forEach((k) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          row[k.toLowerCase().trim()] = raw[k];
        });

        // Required fields
        const cpf = row.cpf || row.documento;
        if (!cpf) throw new Error('CPF is required');

        // 1. Upsert People
        let birthDate: Date | null = null;
        if (row.birth_date) {
          const parsedDate = new Date(row.birth_date);
          if (!isNaN(parsedDate.getTime())) birthDate = parsedDate;
        }

        const person = await this.prisma.people.upsert({
          where: {
            company_id_cpf: {
              company_id: companyId,
              cpf: String(cpf),
            },
          },
          update: {
            name: row.name || row.nome || undefined,
            email: row.email || undefined,
            birth_date: birthDate,
            updated_at: new Date(),
          },
          create: {
            company_id: companyId,
            cpf: String(cpf),
            name: row.name || row.nome,
            email: row.email,
            birth_date: birthDate,
          },
        });

        // 2. Upsert Phones
        const phone_number =
          row.phone_number || row.phone || row.telefone || row.celular;

        if (phone_number) {
          const cleanPhone = String(phone_number).replace(/\D/g, '');

          if (cleanPhone) {
            const phone = await this.prisma.phones.upsert({
              where: {
                company_id_phone_number: {
                  company_id: companyId,
                  phone_number: cleanPhone,
                },
              },
              update: {},
              create: {
                company_id: companyId,
                phone_number: cleanPhone,
              },
            });

            // 3. Link People Phones
            await this.prisma.people_phones.upsert({
              where: {
                person_id_phone_id: {
                  person_id: person.id,
                  phone_id: phone.id,
                },
              },
              update: {
                is_primary: String(row.is_primary).toLowerCase() === 'true',
              },
              create: {
                person_id: person.id,
                phone_id: phone.id,
                is_primary: String(row.is_primary).toLowerCase() === 'true',
              },
            });
          }
        }

        // 4. Create Debts
        if (
          row.original_amount !== undefined ||
          row.current_amount !== undefined
        ) {
          const metadata = {
            portfolio: row.portfolio,
            product_type: row.product_type,
            segment: row.segment,
            negotiation_limit: row.negotiation_limit,
            discount_limit: row.discount_limit,
          };

          let dueDate: Date | null = null;
          if (row.due_date) {
            const parsedDate = new Date(row.due_date);
            if (!isNaN(parsedDate.getTime())) dueDate = parsedDate;
          }

          const parseCurrency = (value: string | number | undefined | null) => {
            if (value === undefined || value === null || value === '') return 0;
            if (typeof value === 'number') return value;
            let str = String(value).trim();
            str = str.replace(/[^\d.,-]/g, '');
            str = str.replace(',', '.');
            const num = parseFloat(str);
            return isNaN(num) ? 0 : num;
          };

          await this.prisma.debts.create({
            data: {
              company_id: companyId,
              person_id: person.id,
              contract_number: row.contract_number
                ? String(row.contract_number)
                : null,
              original_amount: parseCurrency(row.original_amount),
              current_amount: parseCurrency(row.current_amount),
              due_date: dueDate,
              status: row.status || 'open',
              metadata: metadata as unknown as Prisma.InputJsonValue,
            },
          });
        }

        validCount++;
        await this.prisma.contacts.update({
          where: { id: contact.id },
          data: { status: 'processed', processed_at: new Date() },
        });
      } catch (e: unknown) {
        const error = e as Error;
        invalidCount++;
        console.error(
          `Error processing contact ${contact.id}:`,
          error.message,
          error.stack,
        );
        errorLog.push({ id: contact.id, error: error.message });
        await this.prisma.contacts.update({
          where: { id: contact.id },
          data: {
            status: 'failed',
            error_message: error.message,
          },
        });
      }
    }

    // Update Import Status
    await this.prisma.imports.update({
      where: { id: importId },
      data: {
        valid_records: validCount,
        invalid_records: invalidCount,
        status:
          invalidCount === pendingContacts.length ? 'failed' : 'completed',
        error_log:
          errorLog.length > 0
            ? (JSON.stringify(errorLog) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        completed_at: new Date(),
      },
    });

    console.log(
      `Import ${importId} finished. Valid: ${validCount}, Invalid: ${invalidCount}`,
    );
    if (invalidCount > 0) {
      console.log('First 5 errors:', errorLog.slice(0, 5));
    }
  }
}
