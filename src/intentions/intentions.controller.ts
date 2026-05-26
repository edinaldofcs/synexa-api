import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateIntentionDto } from './dto/create-intention.dto';
import { UpdateIntentionDto } from './dto/update-intention.dto';
import { IntentionsService } from './intentions.service';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller()
export class IntentionsController {
  constructor(private readonly intentionsService: IntentionsService) {}

  @Post('clients/:clientId/intentions')
  create(
    @Param('clientId') clientId: string,
    @Body() createIntentionDto: CreateIntentionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.intentionsService.create(clientId, createIntentionDto, user.id);
  }

  @Get('clients/:clientId/intentions')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.intentionsService.findAllByClient(clientId, user.id);
  }

  @Get('intentions/:intentionId')
  findOne(
    @Param('intentionId') intentionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.intentionsService.findOne(intentionId, user.id);
  }

  @Patch('intentions/:intentionId')
  update(
    @Param('intentionId') intentionId: string,
    @Body() updateIntentionDto: UpdateIntentionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.intentionsService.update(
      intentionId,
      updateIntentionDto,
      user.id,
    );
  }

  @Delete('intentions/:intentionId')
  remove(
    @Param('intentionId') intentionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.intentionsService.remove(intentionId, user.id);
  }
}
