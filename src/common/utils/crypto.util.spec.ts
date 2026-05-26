import { encrypt, decrypt } from './crypto.util';

describe('crypto.util', () => {
  const key = 'this-is-a-test-key-that-is-32-chars!';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('encrypt', () => {
    it('should encrypt text and return a base64 string', () => {
      const result = encrypt('hello world', key);
      expect(typeof result).toBe('string');
      expect(() => Buffer.from(result, 'base64')).not.toThrow();
    });

    it('should throw when key is less than 32 characters', () => {
      expect(() => encrypt('test', 'short')).toThrow(
        'ENCRYPTION_KEY must be at least 32 characters',
      );
    });

    it('should throw when key is empty', () => {
      expect(() => encrypt('test', '')).toThrow(
        'ENCRYPTION_KEY must be at least 32 characters',
      );
    });

    it('should produce different ciphertexts for the same text+key (random salt+IV)', () => {
      const result1 = encrypt('same text', key);
      const result2 = encrypt('same text', key);
      expect(result1).not.toBe(result2);
    });

    it('should produce different ciphertexts with different keys', () => {
      const key2 = 'different-key-that-has-32-chars!';
      const result1 = encrypt('text', key);
      const result2 = encrypt('text', key2);
      expect(result1).not.toBe(result2);
    });

    it('should encrypt unicode text', () => {
      const result = encrypt('coração 🔥 ñ', key);
      expect(typeof result).toBe('string');
    });

    it('should encrypt empty string', () => {
      const result = encrypt('', key);
      expect(typeof result).toBe('string');
    });

    it('should encrypt long text (5000+ chars)', () => {
      const longText = 'a'.repeat(5001);
      const result = encrypt(longText, key);
      expect(typeof result).toBe('string');
    });
  });

  describe('decrypt', () => {
    it('should decrypt back to original text', () => {
      const original = 'hello world';
      const encrypted = encrypt(original, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(original);
    });

    it('should throw when key is less than 32 characters', () => {
      const encrypted = encrypt('test', key);
      expect(() => decrypt(encrypted, 'short')).toThrow(
        'ENCRYPTION_KEY must be at least 32 characters',
      );
    });

    it('should throw when decrypting with wrong key', () => {
      const key2 = 'different-key-that-has-32-chars!';
      const encrypted = encrypt('secret', key);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('should throw when decrypting tampered data', () => {
      const encrypted = encrypt('secret', key);
      const tampered = encrypted.slice(0, -4) + 'AAAA';
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('should roundtrip unicode text', () => {
      const original = 'coração 🔥 ñ ✓';
      const encrypted = encrypt(original, key);
      expect(decrypt(encrypted, key)).toBe(original);
    });

    it('should roundtrip empty string', () => {
      const encrypted = encrypt('', key);
      expect(decrypt(encrypted, key)).toBe('');
    });

    it('should roundtrip long text (5000+ chars)', () => {
      const longText = 'b'.repeat(5001);
      const encrypted = encrypt(longText, key);
      expect(decrypt(encrypted, key)).toBe(longText);
    });
  });

  describe('roundtrip', () => {
    it('should encrypt and decrypt returning the original text', () => {
      const original = 'roundtrip test';
      const encrypted = encrypt(original, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(original);
    });
  });
});
