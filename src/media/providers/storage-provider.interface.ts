export interface StorageProvider {
  upload(
    bucket: string,
    path: string,
    buffer: Buffer,
    options?: { contentType?: string; cacheControl?: string },
  ): Promise<{ path: string; error?: string }>;

  download(
    bucket: string,
    path: string,
  ): Promise<{ data: Buffer; error?: string }>;

  createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds?: number,
  ): Promise<{ signedUrl: string; error?: string }>;

  ensureBucket(bucket: string): Promise<void>;
}
