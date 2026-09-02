const DEFAULT_MAX_BYTES = 4096;
const PREVIEW_BYTES = 2048;
const SHORT_VALUE_MAX_BYTES = 256;
const PRESERVED_KEYS_BUDGET_BYTES = 1024;

function preserveShortStringKeys(
  value: unknown,
  budgetBytes = PRESERVED_KEYS_BUDGET_BYTES,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const kept: Record<string, string> = {};
  let used = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') continue;
    if (Buffer.byteLength(entry, 'utf8') > SHORT_VALUE_MAX_BYTES) continue;
    const entrySize = Buffer.byteLength(
      JSON.stringify({ [key]: entry }),
      'utf8',
    );
    if (used + entrySize > budgetBytes) break;
    kept[key] = entry;
    used += entrySize;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function truncateToolResult(
  result: unknown,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(result) ?? String(result ?? '');
  } catch {
    serialized = JSON.stringify({ value: String(result) });
  }

  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  if (totalBytes <= maxBytes) return serialized;

  const preview = serialized.slice(0, PREVIEW_BYTES);
  const dropped = totalBytes - Buffer.byteLength(preview, 'utf8');
  const payload: Record<string, unknown> = {
    __truncated: true,
    preview,
    dropped,
  };
  const shortKeys = preserveShortStringKeys(result);
  if (shortKeys) payload.keys = shortKeys;
  return JSON.stringify(payload);
}
