import { IsString, IsOptional } from 'class-validator';

export class UpdatePainelClientDto {
  @IsString()
  @IsOptional()
  company_id?: string;

  @IsString()
  @IsOptional()
  company_name?: string;

  @IsString()
  @IsOptional()
  strategy?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  agent_name?: string;

  @IsString()
  @IsOptional()
  phone_number?: string;

  @IsString()
  @IsOptional()
  account_id?: string;

  @IsString()
  @IsOptional()
  inbox_id?: string;

  @IsString()
  @IsOptional()
  logo_url?: string;
}
