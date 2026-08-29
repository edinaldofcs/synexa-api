import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TracksController } from './tracks.controller';
import { TracksRepository } from './repositories/tracks.repository';
import { TracksService } from './tracks.service';

@Module({
  imports: [CommonModule],
  controllers: [TracksController],
  providers: [TracksService, TracksRepository],
  exports: [TracksService, TracksRepository],
})
export class TracksModule {}
