import {
  IsString,
  IsNotEmpty,
  IsArray,
  ValidateIf,
  IsBoolean,
  IsUrl,
  IsUUID,
  IsInt,
  Min,
  Max,
  ArrayNotEmpty,
} from 'class-validator';

export class UpdateWebhookEndpointDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  client_id?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUrl()
  @IsNotEmpty()
  url?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  events?: string[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(168)
  retention_hours?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  include_transcript?: boolean;
}

export class CreateWebhookEndpointDto {
  @IsUUID() client_id: string;
  @IsUrl() @IsNotEmpty() url: string;
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  events: string[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(168)
  retention_hours?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  include_transcript?: boolean;
}
