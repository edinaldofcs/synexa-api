import { IsOptional, IsString } from 'class-validator';

export class ChatRequestDto {
  @IsOptional()
  @IsString()
  cellPhone?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  transcript?: string;

  @IsOptional()
  @IsString()
  client_phone?: string;

  @IsOptional()
  @IsString()
  company_phone?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class WebhookMessageDto {
  @IsString()
  message!: string;

  @IsString()
  client_id!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  request_origin?: string;
}

export class DeleteSessionDto {
  @IsString()
  client_phone!: string;

  @IsOptional()
  @IsString()
  company_phone?: string;
}
