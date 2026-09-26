import { URL } from 'url';
import { isIP } from 'net';
import { promises as dns } from 'dns';
import { BadRequestException } from '@nestjs/common';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::]']);

const PRIVATE_IPV4_RANGES: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 (inclui 0.0.0.0 e 0.x.x.x)
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc0000000, 0xc00000ff], // IETF protocol assignments
  [0xc0000200, 0xc00002ff], // documentation
  [0xc0586300, 0xc05863ff], // deprecated 6to4 relay
  [0xc6336400, 0xc63364ff], // documentation
  [0xcb007100, 0xcb0071ff], // documentation
  [0xc6120000, 0xc613ffff], // benchmarking
  [0xe0000000, 0xffffffff], // multicast and reserved
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
    return false;
  const num =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

export function isLoopbackOrPrivateIP(ip: string): boolean {
  if (isIP(ip) === 0) return false;

  // IPv4-mapped IPv6 (::ffff:0:0/96) — extrai o IPv4 embutido
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (isIP(ip) === 6) {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const hexMapped = canonical.match(
      /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (hexMapped) {
      const value =
        parseInt(hexMapped[1], 16) * 65536 + parseInt(hexMapped[2], 16);
      return isPrivateIPv4(
        [
          value >>> 24,
          (value >>> 16) & 255,
          (value >>> 8) & 255,
          value & 255,
        ].join('.'),
      );
    }
    // Accept only global unicast, excluding documentation and transition ranges.
    const [prefix, subnet] = canonical.split(':');
    return (
      !/^[23][0-9a-f]{3}:/.test(canonical) ||
      /^(2001:db8:|2002:|3fff:)/.test(canonical) ||
      (prefix === '2001' && parseInt(subnet || '0', 16) < 512)
    );
  }

  return isPrivateIPv4(ip);
}

export async function validateWebhookUrl(
  urlString: string,
  allowLocalInDev = false,
): Promise<void> {
  await resolvePublicHttpUrl(urlString, allowLocalInDev);
}

export async function resolvePublicHttpUrl(
  urlString: string,
  allowLocalInDev = false,
): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new BadRequestException('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only HTTP and HTTPS URLs are allowed');
  }
  if (parsed.username || parsed.password)
    throw new BadRequestException('URL credentials are not allowed');
  allowLocalInDev =
    allowLocalInDev &&
    ['development', 'test'].includes(process.env.ENVIRONMENT || '');

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    if (!allowLocalInDev) {
      throw new BadRequestException('Access to localhost is not allowed');
    }
    return { url: parsed, addresses: [{ address: '127.0.0.1', family: 4 }] };
  }

  // IP literal: valida direto, sem depender de DNS
  if (isIP(hostname) !== 0) {
    if (isLoopbackOrPrivateIP(hostname)) {
      if (!allowLocalInDev) {
        throw new BadRequestException(
          `Access to private/internal IP is not allowed: ${hostname}`,
        );
      }
      return {
        url: parsed,
        addresses: [{ address: hostname, family: isIP(hostname) }],
      };
    }
    return {
      url: parsed,
      addresses: [{ address: hostname, family: isIP(hostname) }],
    };
  }

  // Hostname: fail-closed — não é possível validar um host que não resolve
  let addresses4: string[] = [];
  let addresses6: string[] = [];
  try {
    [addresses4, addresses6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);
  } catch {
    throw new BadRequestException(`DNS resolution failed for ${hostname}`);
  }

  if (addresses4.length === 0 && addresses6.length === 0) {
    throw new BadRequestException(
      `DNS resolution failed for ${hostname}; refusing to forward request to unresolvable host`,
    );
  }

  for (const addr of [...addresses4, ...addresses6]) {
    if (!allowLocalInDev && isLoopbackOrPrivateIP(addr)) {
      throw new BadRequestException(
        `Access to private/internal IP ranges is not allowed: ${addr}`,
      );
    }
  }
  return {
    url: parsed,
    addresses: [
      ...addresses4.map((address) => ({ address, family: 4 })),
      ...addresses6.map((address) => ({ address, family: 6 })),
    ],
  };
}
