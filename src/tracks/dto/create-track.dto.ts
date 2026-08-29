import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ArrayMaxSize,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTrackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'code deve conter apenas letras minúsculas, números e underline',
  })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  category?: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  icon?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  color?: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  examples?: string[];

  @IsUUID()
  @IsOptional()
  agent_id?: string;

  @IsInt()
  @Min(0)
  @Max(9999)
  @IsOptional()
  display_order?: number;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
