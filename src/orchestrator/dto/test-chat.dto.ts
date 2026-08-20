import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TestChatFileDto {
  @IsString()
  @MaxLength(100)
  mimeType: string;

  @IsString()
  @MaxLength(5000000)
  data: string;
}

export class TestChatDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  agentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  externalUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  originChannel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  systemPrompt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TestChatFileDto)
  files?: TestChatFileDto[];
}

export class ClearTestChatDto {
  @IsString()
  @MaxLength(36)
  clientId: string;

  @IsString()
  @MaxLength(256)
  externalUserId: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  originChannel?: string;
}
