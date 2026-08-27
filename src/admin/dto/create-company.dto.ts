import { IsString, IsNotEmpty } from 'class-validator';

export class AdminCreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
