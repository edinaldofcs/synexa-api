import { retryWithBackoff, isRetryableError } from './retry-with-backoff.util';

describe('RetryWithBackoffUtil', () => {
  it('identifica erros que não devem ter retry (401, 403, invalid api key)', () => {
    expect(
      isRetryableError(new Error('401 Unauthorized: Invalid API key')),
    ).toBe(false);
    expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
    expect(isRetryableError(new Error('API Key not found'))).toBe(false);
  });

  it('identifica erros que devem ter retry (429, 500, 503, network)', () => {
    expect(isRetryableError(new Error('429 Rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('executa com sucesso na primeira tentativa sem retries', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, {
      maxRetries: 2,
      initialDelayMs: 10,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('faz retry após erro transitório e retorna sucesso na segunda tentativa', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce('recuperado');

    const onRetry = jest.fn();
    const result = await retryWithBackoff(fn, {
      maxRetries: 2,
      initialDelayMs: 10,
      onRetry,
    });

    expect(result).toBe('recuperado');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('não faz retry se o erro não for retryable (ex: 401)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('401 Invalid API key'));

    await expect(
      retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10 }),
    ).rejects.toThrow('401 Invalid API key');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
