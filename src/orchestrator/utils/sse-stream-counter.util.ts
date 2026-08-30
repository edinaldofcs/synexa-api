import type Redis from 'ioredis';

export const SSE_STREAM_TTL_SECONDS = 120;
export const SSE_STREAM_DEADLINE_MS = 120000;
export const DEFAULT_MAX_CONCURRENT_STREAMS = 5;

export function sseStreamKey(userId: string): string {
  return `sse:streams:${userId}`;
}

/**
 * S05: contador concorrente de streams SSE por usuario (INCR + EX 120).
 * Retorna o total ativo apos o incremento.
 */
export async function acquireSseStream(
  client: Redis,
  userId: string,
): Promise<number> {
  const key = sseStreamKey(userId);
  const count = await client.incr(key);
  await client.expire(key, SSE_STREAM_TTL_SECONDS);
  return count;
}

/**
 * S05: decrementa o contador no finally. Falha aqui nao propaga: a chave
 * expira sozinha via EX 120.
 */
export async function releaseSseStream(
  client: Redis,
  userId: string,
): Promise<void> {
  try {
    await client.decr(sseStreamKey(userId));
  } catch {
    // contador expira sozinho
  }
}

export function parseMaxConcurrentStreams(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENT_STREAMS;
}
