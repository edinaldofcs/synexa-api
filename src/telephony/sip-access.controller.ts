import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { RolesGuard } from '../common/auth/roles.guard';
import { SipAccessService } from './sip-access.service';

@Controller('clients/:clientId/sip-access')
@UseGuards(RolesGuard)
@Roles('platform_admin', 'company_admin')
export class SipAccessController {
  constructor(private readonly service: SipAccessService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() user: unknown,
    @Param('clientId', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(user, id);
  }
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentUser() user: unknown,
    @Param('clientId', ParseUUIDPipe) id: string,
  ) {
    return this.service.generate(user, id);
  }
  @Post('rotate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  rotate(
    @CurrentUser() user: unknown,
    @Param('clientId', ParseUUIDPipe) id: string,
  ) {
    return this.service.generate(user, id, true);
  }
  @Delete()
  @Header('Cache-Control', 'no-store')
  revoke(
    @CurrentUser() user: unknown,
    @Param('clientId', ParseUUIDPipe) id: string,
  ) {
    return this.service.revoke(user, id);
  }
}
