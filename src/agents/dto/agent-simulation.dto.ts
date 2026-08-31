import { IsOptional, IsObject, IsString } from 'class-validator';

export class PreviewPromptDto {
  @IsOptional()
  @IsString()
  agent_id?: string;

  @IsOptional()
  @IsObject()
  agent_data?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  state?: Record<string, unknown>;
}

export class SimulateSequenceDto {
  @IsOptional()
  @IsObject()
  state?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  channel?: string;
}
