import { URL } from 'url';
import { isIP } from 'net';
import { promises as dns } from 'dns';
import { BadRequestException } from '@nestjs/common';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::]']);

const PRIVATE_IPV4_RANGES: [number, number][] = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
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
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;

  if (
    ip.startsWith('fe80:') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip === '::1'
  ) {
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

  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isLoopbackOrPrivateIP(addr)) {
        throw new BadRequestException(
          `Access to private/internal IP ranges is not allowed: ${addr}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    // DNS resolution failure - may be a valid external host that couldn't resolve
    // Allow if the hostname itself isn't a raw IP that's private
    const directIP = isIP(hostname);
    if (directIP !== 0 && isLoopbackOrPrivateIP(hostname)) {
      throw new BadRequestException(
        `Access to private/internal IP is not allowed: ${hostname}`,
      );
    }
  }

  try {
    const addresses6 = await dns.resolve6(hostname);
    for (const addr of addresses6) {
      if (isLoopbackOrPrivateIP(addr)) {
        throw new BadRequestException(
          `Access to private/IPv6 internal ranges is not allowed: ${addr}`,
        );
      }
    }
  } catch {
    // IPv6 resolution failure is acceptable
  }
}
