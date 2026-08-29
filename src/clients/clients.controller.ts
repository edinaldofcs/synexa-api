import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { LlmConfigDto } from './dto/llm-config.dto';
import { ClientsService } from './clients.service';

@Controller()
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get('clients')
  list(@CurrentUser() user: { company_id: string }) {
    return this.clientsService.findAll(user.company_id);
  }

  @Get('clients/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.clientsService.findOne(id, user.company_id);
  }

  @Post('clients')
  create(
    @Body() dto: CreateClientDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.clientsService.create(dto, user.company_id);
  }

  @Patch('clients/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.clientsService.update(id, dto, user.company_id);
  }

  @Delete('clients/:id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.clientsService.remove(id, user.company_id);
  }

  @Post('clients/:id/duplicate')
  duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.clientsService.duplicate(id, user.company_id);
  }

  @Get('clients/:id/llm-config')
  getLlmConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { company_id: string; id: string },
  ) {
    return this.clientsService.getLlmConfig(id, user.company_id, user.id);
  }

  @Put('clients/:id/llm-config')
  saveLlmConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LlmConfigDto,
    @CurrentUser() user: { company_id: string; id: string },
    @Req() req: any,
  ) {
    const rawIp =
      (req?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req?.socket?.remoteAddress ||
      req?.ip ||
      '127.0.0.1';
    const userAgent = (req?.headers?.['user-agent'] as string) || undefined;
    return this.clientsService.saveLlmConfig(
      id,
      body,
      user.company_id,
      user.id,
      rawIp,
      userAgent,
    );
  }
}
