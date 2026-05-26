export class ImportContactDto {
  userId: string;
  fileName?: string;
  fileType?: string;
  data: Record<string, any>[];
}
