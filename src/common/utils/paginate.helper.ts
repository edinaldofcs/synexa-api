export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function parsePagination(params: PaginationParams, maxLimit = 100) {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(Math.max(1, params.limit || 20), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

export function paginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}
