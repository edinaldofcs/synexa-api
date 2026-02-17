import { Controller, Post, Body } from '@nestjs/common';
import { ImportsService } from './imports.service';
import { ImportContactsDto } from './dto/import-contact.dto';

@Controller('import-contacts') // Exposed at /api/import-contacts via global prefix
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post()
  create(@Body() dto: ImportContactsDto) {
    return this.importsService.importContacts(dto);
  }
}
