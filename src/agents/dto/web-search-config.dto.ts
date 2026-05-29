import { IsBoolean, IsOptional } from 'class-validator';

export class WebSearchConfigDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
