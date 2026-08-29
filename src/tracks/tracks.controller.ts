import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateTrackDto } from './dto/create-track.dto';
import { UpdateTrackDto } from './dto/update-track.dto';
import { TracksService } from './tracks.service';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller()
export class TracksController {
  constructor(private readonly tracksService: TracksService) {}

  @Post('clients/:clientId/tracks')
  create(
    @Param('clientId') clientId: string,
    @Body() createTrackDto: CreateTrackDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.tracksService.create(clientId, createTrackDto, user.company_id);
  }

  @Get('clients/:clientId/tracks')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.tracksService.findAllByClient(clientId, user.company_id);
  }

  @Get('tracks/:trackId')
  findOne(
    @Param('trackId') trackId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.tracksService.findOne(trackId, user.company_id);
  }

  @Patch('tracks/:trackId')
  update(
    @Param('trackId') trackId: string,
    @Body() updateTrackDto: UpdateTrackDto,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.tracksService.update(trackId, updateTrackDto, user.company_id);
  }

  @Delete('tracks/:trackId')
  remove(
    @Param('trackId') trackId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    return this.tracksService.remove(trackId, user.company_id);
  }
}
