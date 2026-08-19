import { IsOptional, IsObject } from 'class-validator';

export class LlmConfigDto {
  @IsOptional()
  @IsObject()
  providers?: Record<string, unknown>;
}
