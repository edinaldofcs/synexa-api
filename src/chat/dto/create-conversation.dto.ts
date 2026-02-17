import { IsOptional, IsUUID } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  companyId: string;

  @IsUUID()
  personId: string;

  @IsOptional()
  @IsUUID()
  debtId?: string;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}
