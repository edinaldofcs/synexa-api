import { promises as dns } from 'dns';
import { BlockList, isIP } from 'net';
import { request } from 'https';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6');

export function isPublicExportAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  );
}

/** Pin the validated DNS answer to the connection to prevent DNS rebinding. */
export async function postCallExport(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password)
    throw new Error('Invalid destination');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      isIP(hostname)
        ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
        : dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 10000);
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicExportAddress(address))
    )
      throw new Error('Blocked destination');
    const address = addresses[0];
    return await new Promise<number>((resolve, reject) => {
      const req = request(
        target,
        {
          method: 'POST',
          agent: false,
          signal: AbortSignal.timeout(10000),
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          // No redirects, no response content stored; only HTTP acknowledgement.
          resolve(response.statusCode || 0);
          response.destroy();
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
