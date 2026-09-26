import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  Min,
  Max,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PartnerInvitationDto {
  @IsIn(['link', 'email'])
  delivery: 'link' | 'email';
}

export class CompanyVoiceLimitDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  maxConcurrentCalls: number;
}

export class CreatePartnerDto extends PartnerInvitationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxConcurrentCalls?: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  companyName: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  adminName: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ActivatePartnerDto {
  @IsOptional()
  @IsIn(['invite', 'recovery'])
  verificationType?: 'invite' | 'recovery';

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  tokenHash?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  accessToken?: string;

  @IsString()
  @MinLength(12, { message: 'Use pelo menos 12 caracteres.' })
  @MaxLength(72)
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, {
    message: 'Inclua letras e números na senha.',
  })
  password: string;
}
