import { IsString, IsOptional, MaxLength, IsUUID } from 'class-validator';

export class UpdateClientDto {
  @IsUUID('4')
  @IsOptional()
  company_id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  company_name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  strategy?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  status?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  agent_name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  phone_number?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  account_id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  inbox_id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  logo_url?: string;
}
