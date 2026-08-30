import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, normalize } from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { StorageProvider } from './storage-provider.interface';

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly basePath: string;
  private readonly baseUrl: string;

  constructor() {
    this.basePath = resolve(process.env.LOCAL_STORAGE_PATH || './uploads');
    this.baseUrl = process.env.LOCAL_STORAGE_URL || '/uploads';

    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
      this.logger.log(`Local storage initialized at ${this.basePath}`);
    }
  }

  async upload(
    bucket: string,
    path: string,
    buffer: Buffer,
    options?: { contentType?: string; cacheControl?: string },
  ): Promise<{ path: string; error?: string }> {
    try {
      const safePath = this.sanitizePath(bucket, path);
      const fullDir = join(this.basePath, safePath.dir);
      const fullPath = join(fullDir, safePath.file);

      if (!existsSync(fullDir)) {
        mkdirSync(fullDir, { recursive: true });
      }

      writeFileSync(fullPath, buffer);
      this.logger.debug(`File saved to ${fullPath}`);

      return { path: `${safePath.dir}/${safePath.file}` };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown upload error';
      this.logger.error(`Upload failed: ${message}`);
      return { path: '', error: message };
    }
  }

  async download(
    bucket: string,
    path: string,
  ): Promise<{ data: Buffer; error?: string }> {
    try {
      const safePath = this.sanitizePath(bucket, path);
      const fullPath = join(this.basePath, safePath.dir, safePath.file);

      if (!existsSync(fullPath)) {
        return { data: Buffer.alloc(0), error: 'File not found' };
      }

      const data = readFileSync(fullPath);
      return { data };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown download error';
      this.logger.error(`Download failed: ${message}`);
      return { data: Buffer.alloc(0), error: message };
    }
  }

  async createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds = 300,
  ): Promise<{ signedUrl: string; error?: string }> {
    const safePath = this.sanitizePath(bucket, path);
    const exp = Date.now() + expiresInSeconds * 1000;
    const sig = this.signKey(safePath.dir, safePath.file, exp);
    const signedUrl = `${this.baseUrl}/${safePath.dir}/${safePath.file}?exp=${exp}&sig=${sig}`;
    return { signedUrl };
  }

  verifySignedParams(
    key: string,
    file: string,
    exp: string | number,
    sig: string,
  ): boolean {
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
    if (!sig) return false;
    const expected = this.signKey(key, file, expMs);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private signKey(key: string, file: string, expMs: number): string {
    const secret = process.env.ENCRYPTION_KEY || '';
    return createHmac('sha256', secret)
      .update(`${key}:${file}:${expMs}`)
      .digest('hex');
  }

  async ensureBucket(bucket: string): Promise<void> {
    const bucketPath = join(this.basePath, bucket);
    if (!existsSync(bucketPath)) {
      mkdirSync(bucketPath, { recursive: true });
      this.logger.log(`Bucket directory created: ${bucketPath}`);
    }
  }

  private sanitizePath(bucket: string, filePath: string) {
    const safeBucket = bucket.replace(/[^a-zA-Z0-9_-]/g, '');
    const normalized = normalize(filePath).replace(/^[./\\]+/, '');
    const parts = normalized.replace(/\\/g, '/').split('/');

    const fileName = parts.pop() || randomUUID();
    const dir = join(this.basePath, safeBucket, ...parts);

    const resolvedDir = resolve(dir);
    const resolvedBase = resolve(this.basePath, safeBucket);
    if (!resolvedDir.startsWith(resolvedBase)) {
      throw new BadRequestException('Invalid path: path traversal detected');
    }

    return {
      dir: join(safeBucket, ...parts).replace(/\\/g, '/'),
      file: fileName,
    };
  }
}
