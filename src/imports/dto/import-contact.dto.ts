export class ImportContactDto {
  userId?: string;
  companyId?: string;
  fileName?: string;
  fileType?: string;
  data: Record<string, any>[];
}
