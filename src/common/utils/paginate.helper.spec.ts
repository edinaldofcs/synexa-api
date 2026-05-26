import { parsePagination, paginatedResult } from './paginate.helper';

describe('paginate.helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parsePagination', () => {
    it('should return defaults page=1, limit=20 when no params', () => {
      const result = parsePagination({});
      expect(result).toEqual({ page: 1, limit: 20, skip: 0 });
    });

    it('should use custom page and limit', () => {
      const result = parsePagination({ page: 3, limit: 10 });
      expect(result).toEqual({ page: 3, limit: 10, skip: 20 });
    });

    it('should clamp page < 1 to 1', () => {
      const result = parsePagination({ page: 0, limit: 20 });
      expect(result.page).toBe(1);
      expect(result.skip).toBe(0);
    });

    it('should clamp negative page to 1', () => {
      const result = parsePagination({ page: -5, limit: 20 });
      expect(result.page).toBe(1);
    });

    it('should treat limit=0 as "not provided" and default to 20', () => {
      const result = parsePagination({ page: 1, limit: 0 });
      expect(result.limit).toBe(20);
    });

    it('should clamp limit > maxLimit (default 100) to maxLimit', () => {
      const result = parsePagination({ page: 1, limit: 200 });
      expect(result.limit).toBe(100);
    });

    it('should clamp limit to custom maxLimit=50', () => {
      const result = parsePagination({ page: 1, limit: 100 }, 50);
      expect(result.limit).toBe(50);
    });

    it('should respect limit within custom maxLimit', () => {
      const result = parsePagination({ page: 1, limit: 30 }, 50);
      expect(result.limit).toBe(30);
    });

    it('should calculate skip correctly for page=1, limit=20 → skip=0', () => {
      const result = parsePagination({ page: 1, limit: 20 });
      expect(result.skip).toBe(0);
    });

    it('should calculate skip correctly for page=3, limit=10 → skip=20', () => {
      const result = parsePagination({ page: 3, limit: 10 });
      expect(result.skip).toBe(20);
    });

    it('should calculate skip correctly for page=5, limit=10 → skip=40', () => {
      const result = parsePagination({ page: 5, limit: 10 });
      expect(result.skip).toBe(40);
    });

    it('should clamp negative limit to 1 after Math.max(1, ...)', () => {
      const result = parsePagination({ page: 1, limit: -5 });
      expect(result.limit).toBe(1);
    });
  });

  describe('paginatedResult', () => {
    it('should return empty result with totalPages=0 for empty array', () => {
      const result = paginatedResult([], 0, 1, 20);
      expect(result).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });
    });

    it('should calculate totalPages=2 for 10 items, total=10, page=1, limit=5', () => {
      const data = Array.from({ length: 5 }, (_, i) => ({ id: i }));
      const result = paginatedResult(data, 10, 1, 5);
      expect(result.totalPages).toBe(2);
      expect(result.data).toHaveLength(5);
    });

    it('should calculate totalPages=10 for 100 items, total=100, limit=10', () => {
      const data = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const result = paginatedResult(data, 100, 1, 10);
      expect(result.totalPages).toBe(10);
    });

    it('should calculate totalPages=3 for 7 items, limit=3 (odd totals)', () => {
      const data = Array.from({ length: 3 }, (_, i) => ({ id: i }));
      const result = paginatedResult(data, 7, 1, 3);
      expect(result.totalPages).toBe(3);
    });

    it('should calculate totalPages=1 when total equals limit', () => {
      const data = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const result = paginatedResult(data, 10, 1, 10);
      expect(result.totalPages).toBe(1);
    });

    it('should calculate totalPages=1 when total < limit', () => {
      const data = Array.from({ length: 5 }, (_, i) => ({ id: i }));
      const result = paginatedResult(data, 5, 1, 10);
      expect(result.totalPages).toBe(1);
    });

    it('should preserve page and limit in result', () => {
      const result = paginatedResult([], 0, 3, 15);
      expect(result.page).toBe(3);
      expect(result.limit).toBe(15);
    });
  });
});
