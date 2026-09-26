import {
  IsBase64,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class TestVoiceProviderDto {
  @IsIn(['tts', 'stt'])
  kind!: 'tts' | 'stt';

  @IsString()
  @MaxLength(2048)
  baseUrl!: string;

  @IsString()
  @MaxLength(4096)
  @IsOptional()
  apiKey?: string;

  @IsString()
  @MaxLength(100)
  @IsOptional()
  voice?: string;

  @IsInt()
  @Min(8000)
  @Max(48000)
  @IsOptional()
  outputSampleRate?: number;

  @IsInt()
  @Min(500)
  @Max(30000)
  @IsOptional()
  timeoutMs?: number;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  text?: string;

  /** WAV PCM16 mono 16kHz, até 20 segundos; nunca persistido. */
  @IsBase64()
  @MaxLength(900000)
  @IsOptional()
  audioBase64?: string;
}
