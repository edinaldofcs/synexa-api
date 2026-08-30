export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  const errMessage = error instanceof Error ? error.message : String(error);

  // Erros de autenticação / cliente não devem ter retry
  if (
    /401|403|unauthorized|forbidden|invalid api key|api key not found/i.test(
      errMessage,
    )
  ) {
    return false;
  }

  // 400 Bad Request que não seja rate limit
  if (
    /400|bad request|invalid argument/i.test(errMessage) &&
    !/rate limit|quota/i.test(errMessage)
  ) {
    return false;
  }

  // Erros de rede, rate limit ou status 5xx devem ter retry
  if (
    /429|500|502|503|504|econnreset|etimedout|network|fetch failed|rate limit|quota exceeded|overloaded/i.test(
      errMessage,
    )
  ) {
    return true;
  }

  // Fail-closed: erro desconhecido não é retentável automaticamente —
  // o default anterior (true) re-executava side effects de tools
  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const initialDelayMs = options.initialDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 3000;
  const factor = options.factor ?? 2;
  const useJitter = options.jitter ?? true;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      let delay = initialDelayMs * Math.pow(factor, attempt);
      if (useJitter) {
        const jitter = Math.random() * (initialDelayMs * 0.5);
        delay += jitter;
      }
      delay = Math.min(delay, maxDelayMs);

      if (options.onRetry) {
        options.onRetry(error, attempt + 1, delay);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
