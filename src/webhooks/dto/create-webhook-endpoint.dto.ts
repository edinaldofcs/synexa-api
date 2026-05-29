import { IsString, IsNotEmpty, IsArray, IsOptional, IsBoolean, IsUrl } from 'class-validator';

export class CreateWebhookEndpointDto {
  @IsUrl()
  @IsNotEmpty()
  url: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  events: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
