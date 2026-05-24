import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { ClientsService } from './clients.service';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Post()
  create(@Body() createClientDto: CreateClientDto) {
    return this.clientsService.create(createClientDto);
  }

  @Get()
  findAll(@CurrentUser() user: { id: string }) {
    return this.clientsService.findAll(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.findOne(id, user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateClientDto: UpdateClientDto, @CurrentUser() user: { id: string }) {
    return this.clientsService.update(id, updateClientDto, user.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.remove(id, user.id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.clientsService.duplicate(id, user.id);
  }
}
