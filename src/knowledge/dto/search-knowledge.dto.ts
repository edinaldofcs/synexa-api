import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SearchKnowledgeDto {
  @IsString()
  query!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
