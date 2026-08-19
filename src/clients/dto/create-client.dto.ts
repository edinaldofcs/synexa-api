import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateClientDto {
  @IsString()
  @IsOptional()
  @MaxLength(36)
  user_id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  company_name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  status?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  agent_name?: string;

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

  @IsString()
  @IsOptional()
  @MaxLength(50)
  logo_icon?: string;
}
