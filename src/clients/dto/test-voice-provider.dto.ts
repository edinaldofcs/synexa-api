import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class TestVoiceProviderDto {
  @IsIn(['tts', 'stt'])
  kind!: 'tts' | 'stt';

  @IsString()
  baseUrl!: string;

  @IsString()
  @IsOptional()
  apiKey?: string;

  @IsString()
  @IsOptional()
  voice?: string;

  /** Taxa que o endpoint de TTS entrega (default 24000). */
  @IsNumber()
  @IsOptional()
  outputSampleRate?: number;

  @IsNumber()
  @IsOptional()
  timeoutMs?: number;
}
