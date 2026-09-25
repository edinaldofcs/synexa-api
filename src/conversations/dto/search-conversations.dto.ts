import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SearchConversationsDto {
  @IsOptional() @IsUUID() client_id?: string;
  @IsOptional() @IsIn(['active', 'closed', 'deals', 'cpc']) filter?: string;
  @IsOptional() @IsIn(['all', 'deals', 'cpc']) outcome?: string;
  @IsOptional()
  @IsIn(['all', 'whatsapp', 'voice', 'webchat', 'api'])
  channel?: string;
  @IsOptional() @IsISO8601() start?: string;
  @IsOptional() @IsISO8601() end?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100000) page: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit: number = 50;
}
