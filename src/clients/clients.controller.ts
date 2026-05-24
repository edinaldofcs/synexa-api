import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { ClientsService } from './clients.service';

@Controller()
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get('clients')
  list(@CurrentUser() user: { id: string }) {
    return this.clientsService.findAll(user.id);
  }

  @Get('clients/:id')
  get(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.findOne(id, user.id);
  }

  @Post('clients')
  create(@Body() dto: CreateClientDto) {
    return this.clientsService.create(dto);
  }

  @Post('clients/:id')
  update(@Param('id') id: string, @Body() dto: UpdateClientDto, @CurrentUser() user: { id: string }) {
    return this.clientsService.update(id, dto, user.id);
  }

  @Post('clients/:id/delete')
  remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.remove(id, user.id);
  }

  @Post('clients/:id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.duplicate(id, user.id);
  }
}
