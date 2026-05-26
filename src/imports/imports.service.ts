import { Injectable, Logger } from '@nestjs/common';
import { ImportContactDto } from './dto/import-contact.dto';

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  async importContacts(dto: ImportContactDto) {
    this.logger.log(
      `Importing ${dto.data.length} contacts for user ${dto.userId}`,
    );

    return {
      success: true,
      message: `${dto.data.length} registros importados com sucesso.`,
      importId: crypto.randomUUID(),
    };
  }
}
