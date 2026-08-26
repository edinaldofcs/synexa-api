import {
  IsNotEmpty,
  IsString,
  MaxLength,
  IsOptional,
  IsBoolean,
  IsNumber,
} from 'class-validator';

export class PublishVersionDto {
  @IsNotEmpty({ message: 'A nota de versão é obrigatória' })
  @IsString()
  @MaxLength(500, {
    message: 'A nota de versão deve ter no máximo 500 caracteres',
  })
  description!: string;
}

export class RollbackVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateSnapshotDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsNumber()
  baseVersion?: number;
}

export class UpdateVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  captureCurrentState?: boolean;

  @IsOptional()
  @IsNumber()
  baseVersion?: number;

  @IsOptional()
  snapshot?: any;
}
