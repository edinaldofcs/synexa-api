import { IsArray, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class MessagePartDto {
  @IsString()
  type!: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  mime_type?: string;

  @IsOptional()
  @IsNumber()
  file_size?: number;

  @IsOptional()
  @IsString()
  checksum?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class MessageContentDto {
  @IsString()
  type!: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessagePartDto)
  parts?: MessagePartDto[];
}

export class SendMessageDto {
  @IsString()
  client_id!: string;

  @IsString()
  origin_channel!: string;

  @IsString()
  external_user_id!: string;

  @IsOptional()
  @IsString()
  conversation_key?: string;

  @IsOptional()
  @IsString()
  idempotency_key?: string;

  @ValidateNested()
  @Type(() => MessageContentDto)
  message!: MessageContentDto;

  @IsOptional()
  @IsString()
  return_webhook_url?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
