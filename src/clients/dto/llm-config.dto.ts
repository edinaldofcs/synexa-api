import { IsOptional, IsString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class LlmProviderDto {
  @IsString()
  apiKey: string;

  @IsArray()
  @IsString({ each: true })
  enabledModels: string[];
}

export class LlmConfigDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => Object)
  providers?: Record<string, LlmProviderDto>;
}
