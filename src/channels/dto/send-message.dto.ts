import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_CHANNELS = [
  'api',
  'whatsapp',
  'telegram',
  'instagram',
  'messenger',
  'webchat',
];

class MessagePartDto {
  @IsString()
  @MaxLength(50)
  @IsIn(['text', 'image', 'audio', 'file'], {
    message: 'part type deve ser: text, image, audio ou file',
  })
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mime_type?: string;

  @IsOptional()
  @IsNumber()
  file_size?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  checksum?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class MessageContentDto {
  @IsString()
  @MaxLength(50)
  @IsIn(['text', 'image', 'audio', 'file', 'mixed'], {
    message: 'message.type deve ser: text, image, audio, file ou mixed',
  })
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessagePartDto)
  parts?: MessagePartDto[];
}

export class SendMessageDto {
  @IsString()
  @MaxLength(36)
  client_id!: string;

  @IsString()
  @IsIn(VALID_CHANNELS, { message: 'origin_channel deve ser um canal válido' })
  @MaxLength(50)
  origin_channel!: string;

  @IsString()
  @MaxLength(256)
  external_user_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  conversation_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotency_key?: string;

  @ValidateNested()
  @Type(() => MessageContentDto)
  message!: MessageContentDto;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  return_webhook_url?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
