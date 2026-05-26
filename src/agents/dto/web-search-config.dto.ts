import { IsBoolean, IsArray, IsString, IsOptional } from 'class-validator';

export class WebSearchConfigDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  domains_allowed?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  domains_blocked?: string[];
}
