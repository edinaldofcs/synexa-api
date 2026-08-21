import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { SubagentsService } from './subagents.service';
import { CreateSubagentDto } from './dto/create-subagent.dto';
import { UpdateSubagentDto } from './dto/update-subagent.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller('subagents')
export class SubagentsController {
  constructor(private readonly subagentsService: SubagentsService) {}

  @Get()
  findAllByClient(
    @Query('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.subagentsService.findAllByClient(clientId, user.id);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.subagentsService.findOne(id, user.id);
  }

  @Post()
  create(
    @Query('clientId') clientId: string,
    @Body() dto: CreateSubagentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.subagentsService.create(clientId, dto, user.id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSubagentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.subagentsService.update(id, dto, user.id);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.subagentsService.remove(id, user.id);
  }
}
