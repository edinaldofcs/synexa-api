import { IsString, IsOptional, IsInt, IsBoolean } from 'class-validator';

export class UpdatePainelAgentDto {
    @IsString()
    @IsOptional()
    model?: string;

    @IsString()
    @IsOptional()
    service_step?: string;

    @IsInt()
    @IsOptional()
    execution_order?: number;

    @IsString()
    @IsOptional()
    agent_identity?: string;

    @IsString()
    @IsOptional()
    language_guidelines?: string;

    @IsString()
    @IsOptional()
    system_context?: string;

    @IsString()
    @IsOptional()
    available_tools?: string;

    @IsString()
    @IsOptional()
    conversation_flow?: string;

    @IsString()
    @IsOptional()
    output_rules?: string;

    @IsString()
    @IsOptional()
    security_rules?: string;

    @IsInt()
    @IsOptional()
    version?: number;

    @IsBoolean()
    @IsOptional()
    is_active?: boolean;
}
