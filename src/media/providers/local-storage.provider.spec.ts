import { createHmac } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalStorageProvider } from './local-storage.provider';

describe('LocalStorageProvider - signed URL HMAC', () => {
  const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
  const ORIGINAL_PATH = process.env.LOCAL_STORAGE_PATH;
  const SECRET = 'test-encryption-key-with-32-characters!';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = SECRET;
    process.env.LOCAL_STORAGE_PATH = join(tmpdir(), 'synexa-test-uploads');
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    if (ORIGINAL_PATH === undefined) delete process.env.LOCAL_STORAGE_PATH;
    else process.env.LOCAL_STORAGE_PATH = ORIGINAL_PATH;
  });

  function extractParams(url: string) {
    const query = url.split('?')[1];
    const params = new URLSearchParams(query);
    return {
      file: url.split('/').pop()!.split('?')[0],
      dir: url
        .split('?')[0]
        .replace(/^\/?uploads\//, '')
        .replace(/\/[^/]+$/, ''),
      exp: params.get('exp')!,
      sig: params.get('sig')!,
    };
  }

  it('should produce expiring signed URLs with a valid HMAC signature', async () => {
    const provider = new LocalStorageProvider();
    const { signedUrl } = await provider.createSignedUrl(
      'bucket-1',
      'company/client/2026/01/file.png',
      300,
    );

    expect(signedUrl).not.toMatch(/[?&]t=\d+/);
    expect(signedUrl).not.toMatch(/[?&]expires=\d+/);

    const { dir, file, exp, sig } = extractParams(signedUrl);
    const expected = createHmac('sha256', SECRET)
      .update(`${dir}:${file}:${exp}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('should accept a signature produced with the same secret', async () => {
    const provider = new LocalStorageProvider();
    const { signedUrl } = await provider.createSignedUrl(
      'bucket-1',
      'company/client/2026/01/file.png',
      300,
    );

    const { dir, file, exp, sig } = extractParams(signedUrl);
    expect(provider.verifySignedParams(dir, file, exp, sig)).toBe(true);
  });

  it('should reject a tampered signature', async () => {
    const provider = new LocalStorageProvider();
    const { signedUrl } = await provider.createSignedUrl(
      'bucket-1',
      'company/client/2026/01/file.png',
      300,
    );

    const { dir, file, exp, sig } = extractParams(signedUrl);
    const tampered = sig.replace(/[0-9a-f]/i, (c) => (c === '0' ? '1' : '0'));
    expect(provider.verifySignedParams(dir, file, exp, tampered)).toBe(false);
  });

  it('should reject an expired signature', async () => {
    const provider = new LocalStorageProvider();
    const { signedUrl } = await provider.createSignedUrl(
      'bucket-1',
      'company/client/2026/01/file.png',
      300,
    );

    const { dir, file, exp, sig } = extractParams(signedUrl);
    const expiredExp = String(Number(exp) - 1000 * 60 * 10);
    expect(provider.verifySignedParams(dir, file, expiredExp, sig)).toBe(false);
  });
});
