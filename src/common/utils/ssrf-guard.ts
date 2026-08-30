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
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
    return false;
  const num = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  return PRIVATE_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

function isLoopbackOrPrivateIP(ip: string): boolean {
  if (isIP(ip) === 0) return false;

  // IPv4-mapped IPv6 (::ffff:0:0/96) — extrai o IPv4 embutido
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  return isPrivateIPv4(ip);
}

export async function validateWebhookUrl(
  urlString: string,
  allowLocalInDev = false,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new BadRequestException('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only HTTP and HTTPS URLs are allowed');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    if (!allowLocalInDev) {
      throw new BadRequestException('Access to localhost is not allowed');
    }
    return;
  }

  // IP literal: valida direto, sem depender de DNS
  if (isIP(hostname) !== 0) {
    if (isLoopbackOrPrivateIP(hostname)) {
      if (!allowLocalInDev) {
        throw new BadRequestException(
          `Access to private/internal IP is not allowed: ${hostname}`,
        );
      }
      return;
    }
    return;
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
    if (isLoopbackOrPrivateIP(addr)) {
      throw new BadRequestException(
        `Access to private/internal IP ranges is not allowed: ${addr}`,
      );
    }
  }
}
