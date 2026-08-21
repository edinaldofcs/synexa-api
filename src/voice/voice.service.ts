import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface VoiceConfigResponse {
  hasApiKey: boolean;
  defaultModel: string;
  defaultVoice: string;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly configService: ConfigService) {}

  getGeminiApiKey(): string {
    return (
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      ''
    );
  }

  getDefaultModel(): string {
    return (
      this.configService.get<string>('GEMINI_LIVE_MODEL') ||
      'gemini-3.1-flash-live-preview'
    );
  }

  getDefaultVoice(): string {
    return this.configService.get<string>('GEMINI_DEFAULT_VOICE') || 'Kore';
  }

  getConfig(): VoiceConfigResponse {
    const key = this.getGeminiApiKey();
    return {
      hasApiKey: Boolean(key && key.trim().length > 0),
      defaultModel: this.getDefaultModel(),
      defaultVoice: this.getDefaultVoice(),
    };
  }
}
