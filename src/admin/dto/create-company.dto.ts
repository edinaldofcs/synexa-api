import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';

export class AdminCreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  cnpj?: string;

  @IsOptional()
  @IsIn(['starter', 'professional', 'scale', 'enterprise'])
  plan?: string;
}
