import { IsString, IsOptional, IsUUID, IsEnum } from 'class-validator';

export class CreateMessageDto {
  @IsUUID()
  companyId: string;

  @IsString()
  content: string;

  @IsEnum(['customer', 'ai', 'human'])
  senderType: string;

  @IsEnum(['whatsapp', 'sms', 'webchat', 'api'])
  channel: string;

  @IsOptional()
  attachments?: Record<string, unknown>[];
}
