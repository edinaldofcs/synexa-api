import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsInt, IsObject } from 'class-validator';

export class CreatePainelApiDto {
    @IsString()
    @IsNotEmpty()
    agent_id: string;

    @IsString()
    @IsOptional()
    next_api_id?: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsString()
    @IsOptional()
    field_description?: string;

    @IsString()
    @IsNotEmpty()
    method: string;

    @IsString()
    @IsNotEmpty()
    url: string;

    @IsBoolean()
    @IsOptional()
    visible_to_agent?: boolean;

    @IsObject()
    @IsOptional()
    request_schema?: any;

    @IsObject()
    @IsOptional()
    response_schema?: any;

    @IsObject()
    @IsOptional()
    extract_data?: any;

    @IsInt()
    @IsOptional()
    execution_order?: number;

    @IsBoolean()
    @IsOptional()
    is_active?: boolean;
}
