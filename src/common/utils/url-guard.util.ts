const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^198\.1[89]\./,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
]);

/** Limite de resposta de endpoints custom (10MB). */
export const MAX_CUSTOM_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Validação SSRF para endpoints HTTP configurados por tenants (BYO TTS/STT).
 * Regras: https obrigatório em produção (http liberado em dev/test),
 * hosts privados/loopback bloqueados.
 */
export function assertPublicHttpUrl(
  rawUrl: string,
  label = 'endpoint',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label}: URL inválida: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `${label}: apenas http/https são suportados (recebido ${parsed.protocol})`,
    );
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && parsed.protocol !== 'https:') {
    throw new Error(
      `${label}: em produção apenas https é permitido (${parsed.protocol})`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`${label}: host não permitido (${hostname})`);
  }

  if (isPrivateIpv4(hostname)) {
    throw new Error(
      `${label}: endereços privados/loopback não são permitidos (${hostname})`,
    );
  }

  if (hostname.startsWith('[') && /(::1|fc00|fc01|fd00|fe80)/i.test(hostname)) {
    throw new Error(`${label}: endereço IPv6 privado não permitido`);
  }

  return parsed;
}

/**
 * Timeout para chamadas a endpoints custom (5s default, teto de 30s).
 */
export function customHttpTimeout(overrideMs?: number): number {
  const value = overrideMs && overrideMs > 0 ? overrideMs : 5_000;
  return Math.min(value, 30_000);
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(hostname));
}
