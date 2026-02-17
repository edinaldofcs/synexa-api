import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class UpdatePainelIntentionDto {
    @IsString()
    @IsOptional()
    code?: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsBoolean()
    @IsOptional()
    is_active?: boolean;
}
