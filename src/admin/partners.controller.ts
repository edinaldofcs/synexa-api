import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import { PlatformOwnerGuard } from '../common/auth/platform-owner.guard';
import { PartnersService } from './partners.service';
import {
  ActivatePartnerDto,
  CreatePartnerDto,
  CompanyVoiceLimitDto,
  PartnerInvitationDto,
} from './dto/partner.dto';

@Controller('admin/partners')
@UseGuards(PlatformOwnerGuard)
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get()
  list() {
    return this.partners.list();
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  create(@CurrentUser() actor: { id: string }, @Body() body: CreatePartnerDto) {
    return this.partners.create(actor.id, body);
  }

  @Patch(':companyId/limits')
  updateLimit(
    @CurrentUser() actor: { id: string },
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() body: CompanyVoiceLimitDto,
  ) {
    return this.partners.updateLimit(
      actor.id,
      companyId,
      body.maxConcurrentCalls,
    );
  }

  @Post(':userId/invitation')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  invite(
    @CurrentUser() actor: { id: string },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: PartnerInvitationDto,
  ) {
    return this.partners.invite(actor.id, userId, body.delivery);
  }
}

@Controller('auth')
export class PartnerActivationController {
  constructor(private readonly partners: PartnersService) {}

  @Public()
  @Post('activate-account')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async activate(@Body() body: ActivatePartnerDto) {
    await this.partners.activate(body);
    return { success: true };
  }
}
