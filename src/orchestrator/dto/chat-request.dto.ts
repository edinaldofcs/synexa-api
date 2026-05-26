import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ChatRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  cellPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  transcript?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  client_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  company_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  message?: string;
}

export class WebhookMessageDto {
  @IsString()
  @MaxLength(10000)
  message!: string;

  @IsString()
  @MaxLength(36)
  client_id!: string;

  @IsString()
  @MaxLength(50)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  request_origin?: string;
}

export class DeleteSessionDto {
  @IsString()
  @MaxLength(50)
  client_phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  company_phone?: string;
}
