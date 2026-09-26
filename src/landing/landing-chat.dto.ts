import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

class LandingHistoryMessage {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';
  @IsString()
  @MaxLength(2400)
  content: string;
}
export class LandingChatDto {
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
