import { BadRequestException } from '@nestjs/common';
import { validateUUID } from './uuid.helper';

describe('uuid.helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateUUID', () => {
    it('should return the UUID for a valid UUID v4 (lowercase)', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateUUID(uuid)).toBe(uuid);
    });

    it('should return the UUID as-is for a valid UUID (uppercase)', () => {
      const uuid = '550E8400-E29B-41D4-A716-446655440000';
      expect(validateUUID(uuid)).toBe(uuid);
    });

    it('should return the UUID as-is for mixed case', () => {
      const uuid = '550E8400-e29B-41d4-A716-446655440000';
      expect(validateUUID(uuid)).toBe(uuid);
    });

    it('should return the UUID for valid nil UUID', () => {
      const uuid = '00000000-0000-0000-0000-000000000000';
      expect(validateUUID(uuid)).toBe(uuid);
    });

    it('should throw BadRequestException for invalid string', () => {
      expect(() => validateUUID('not-a-uuid')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for empty string', () => {
      expect(() => validateUUID('')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for missing dashes', () => {
      const uuid = '550e8400e29b41d4a716446655440000';
      expect(() => validateUUID(uuid)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for non-hex characters', () => {
      const uuid = '550e8400-e29b-41d4-a716-44665544000g';
      expect(() => validateUUID(uuid)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for wrong length', () => {
      const uuid = '550e8400-e29b-41d4-a716-4466554400';
      expect(() => validateUUID(uuid)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for too many characters', () => {
      const uuid = '550e8400-e29b-41d4-a716-4466554400000';
      expect(() => validateUUID(uuid)).toThrow(BadRequestException);
    });

    it('should include default fieldName "id" in error message', () => {
      expect(() => validateUUID('invalid')).toThrow(
        'id deve ser um UUID válido',
      );
    });

    it('should include custom fieldName in error message', () => {
      expect(() => validateUUID('invalid', 'userId')).toThrow(
        'userId deve ser um UUID válido',
      );
    });

    it('should include custom fieldName "company_id" in error message', () => {
      expect(() => validateUUID('invalid', 'company_id')).toThrow(
        'company_id deve ser um UUID válido',
      );
    });

    it('should throw BadRequestException for null', () => {
      expect(() => validateUUID(null as unknown as string)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for undefined', () => {
      expect(() => validateUUID(undefined as unknown as string)).toThrow(
        BadRequestException,
      );
    });
  });
});
