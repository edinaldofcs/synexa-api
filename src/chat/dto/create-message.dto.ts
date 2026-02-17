import { IsString, IsOptional, IsUUID, IsEnum } from 'class-validator';
import { Prisma } from '@prisma/client';

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
  attachments?: Prisma.InputJsonValue;
}
