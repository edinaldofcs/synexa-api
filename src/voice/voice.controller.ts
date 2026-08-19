import { Controller, Get } from '@nestjs/common';
import { VoiceService } from './voice.service';
import type { VoiceConfigResponse } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @Get('config')
  getConfig(): VoiceConfigResponse {
    return this.voiceService.getConfig();
  }
}
