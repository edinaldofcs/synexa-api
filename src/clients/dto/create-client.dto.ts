import {
  IsString,
  IsOptional,
  MaxLength,
  ValidateIf,
  Allow,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @IsOptional()
  @MaxLength(36)
  user_id?: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  company_name?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  status?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  agent_name?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  account_id?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  inbox_id?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  logo_url?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  logo_icon?: string | null;

  @Allow()
  @IsOptional()
  metadata?: Record<string, unknown> | null;
}
