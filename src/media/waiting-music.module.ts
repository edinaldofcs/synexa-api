import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { WaitingMusicController } from './waiting-music.controller';
import { WaitingMusicService } from './waiting-music.service';
import { WaitingMusicStorage } from './waiting-music.storage';

/** No chat queues: this module also runs in the standalone voice process. */
@Module({
  imports: [CommonModule],
  controllers: [WaitingMusicController],
  providers: [WaitingMusicService, WaitingMusicStorage],
  exports: [WaitingMusicService],
})
export class WaitingMusicModule {}
