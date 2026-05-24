import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [CommonModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
