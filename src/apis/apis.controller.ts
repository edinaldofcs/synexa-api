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
    @CurrentUser() user: { company_id: string },
  ) {
    return this.apisService.create(clientId, payload, user.company_id);
  }

  @Get('clients/:clientId/apis')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.apisService.findAllByClient(clientId, user.company_id);
  }

  @Get('apis/:apiId')
  findOne(
    @Param('apiId') apiId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.apisService.findOne(apiId, user.company_id);
  }

  @Patch('apis/:apiId')
  update(
    @Param('apiId') apiId: string,
    @Body() payload: UpdateApiDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.apisService.update(apiId, payload, user.company_id);
  }

  @Post('apis/test-proxy')
  testProxy(
    @Body()
    payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    },
  ) {
    return this.apisService.testProxy(payload);
  }

  @Delete('apis/:apiId')
  remove(
    @Param('apiId') apiId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.apisService.remove(apiId, user.company_id);
  }
}
