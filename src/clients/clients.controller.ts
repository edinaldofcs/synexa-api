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
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller()
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get('clients')
  list(@CurrentUser() user: { id: string }) {
    return this.clientsService.findAll(user.id);
  }

  @Get('clients/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.clientsService.findOne(id, user.id);
  }

  @Post('clients')
  create(@Body() dto: CreateClientDto, @CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.clientsService.create(dto, ctx.userId, ctx.companyId);
  }

  @Patch('clients/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.clientsService.update(id, dto, user.id);
  }

  @Delete('clients/:id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.clientsService.remove(id, user.id);
  }

  @Post('clients/:id/duplicate')
  duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.clientsService.duplicate(id, user.id);
  }

  @Get('clients/:id/llm-config')
  getLlmConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.clientsService.getLlmConfig(id, user.id);
  }

  @Put('clients/:id/llm-config')
  saveLlmConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LlmConfigDto,
    @CurrentUser() user: { id: string },
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
      user.id,
      rawIp,
      userAgent,
    );
  }
}
