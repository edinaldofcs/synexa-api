import { Controller, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ImportsService } from './imports.service';
import { ImportContactsDto } from './dto/import-contact.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Throttle({ default: { limit: 3, ttl: 60000 } })
@Controller('import-contacts')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post()
  create(
    @Body() dto: ImportContactsDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.importsService.importContacts(dto, user.id);
  }
}
