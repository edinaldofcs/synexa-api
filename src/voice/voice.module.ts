import { Module } from '@nestjs/common';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';

@Module({
  controllers: [VoiceController],
  providers: [VoiceGateway, VoiceService],
  exports: [VoiceService, VoiceGateway],
})
export class VoiceModule {}
