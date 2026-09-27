import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BrandId } from '../common/config/branding';

class LandingHistoryMessage {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';
  @IsString()
  @MaxLength(2400)
  content: string;
}
export class LandingChatDto {
  @IsOptional()
  @IsEnum(BrandId)
  brand?: BrandId;

  @IsString()
  @MinLength(1)
  @MaxLength(1200)
  message: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => LandingHistoryMessage)
  history?: LandingHistoryMessage[];
}
