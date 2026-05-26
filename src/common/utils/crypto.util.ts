import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

function deriveKey(encryptionKey: string, salt: Buffer): Buffer {
  return scryptSync(encryptionKey, salt, 32);
}

export function encrypt(text: string, encryptionKey: string): string {
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(encryptionKey, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const result = Buffer.concat([salt, iv, authTag, encrypted]);
  return result.toString('base64');
}

export function decrypt(encrypted: string, encryptionKey: string): string {
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }

  const buffer = Buffer.from(encrypted, 'base64');

  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = buffer.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const encryptedData = buffer.subarray(
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );

  const key = deriveKey(encryptionKey, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]).toString('utf8');
}
