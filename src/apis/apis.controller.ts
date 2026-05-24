import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApisService } from './apis.service';
import { CreateApiDto } from './dto/create-api.dto';
import { UpdateApiDto } from './dto/update-api.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller()
export class ApisController {
  constructor(private readonly apisService: ApisService) {}

  @Post('clients/:clientId/apis')
  createForClient(
    @Param('clientId') clientId: string,
    @Body() payload: CreateApiDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.apisService.create(clientId, payload, user.id);
  }

  @Get('clients/:clientId/apis')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.apisService.findAllByClient(clientId, user.id);
  }

  @Get('apis/:apiId')
  findOne(
    @Param('apiId') apiId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.apisService.findOne(apiId, user.id);
  }

  @Patch('apis/:apiId')
  update(
    @Param('apiId') apiId: string,
    @Body() payload: UpdateApiDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.apisService.update(apiId, payload, user.id);
  }

  @Delete('apis/:apiId')
  remove(
    @Param('apiId') apiId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.apisService.remove(apiId, user.id);
  }
}
