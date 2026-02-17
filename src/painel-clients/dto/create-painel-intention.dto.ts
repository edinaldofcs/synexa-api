import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreatePainelIntentionDto {
    @IsString()
    @IsNotEmpty()
    client_id: string;

    @IsString()
    @IsNotEmpty()
    code: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsBoolean()
    @IsOptional()
    is_active?: boolean;
}
