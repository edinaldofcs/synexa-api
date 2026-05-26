import { Body, Controller, Post } from '@nestjs/common';
import { ImportContactDto } from './dto/import-contact.dto';
import { ImportsService } from './imports.service';

@Controller()
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('import-contacts')
  async importContacts(@Body() dto: ImportContactDto) {
    return this.importsService.importContacts(dto);
  }
}
