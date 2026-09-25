import { promises as dns } from 'dns';
import { request } from 'https';
import { postCallExport } from './call-export-transport';
jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));
jest.mock('https', () => ({ request: jest.fn() }));
import { isPublicExportAddress } from './call-export-transport';
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '172.16.1.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  'fe80::1',
  'fd00::1',
  '0.0.0.0',
  '224.0.0.1',
  'not-an-ip',
])('blocks non-public destination %s', (address) => {
  expect(isPublicExportAddress(address)).toBe(false);
});
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
  'accepts public destination %s',
  (address) => {
    expect(isPublicExportAddress(address)).toBe(true);
  },
);

describe('HTTPS transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dns.lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ]);
  });
  it('pins the checked DNS address while retaining the original TLS hostname', async () => {
    (request as unknown as jest.Mock).mockImplementation(
      (_url, options, receive) => {
        const callback = jest.fn();
        options.lookup('example.com', { all: true }, callback);
        expect(callback).toHaveBeenCalledWith(null, [
          { address: '8.8.8.8', family: 4 },
        ]);
        return {
          on: jest.fn(),
          end: () => receive({ statusCode: 204, destroy: jest.fn() }),
        };
      },
    );
    expect(await postCallExport('https://example.com/hook', '{}', {})).toBe(
      204,
    );
    expect((request as unknown as jest.Mock).mock.calls[0][0].hostname).toBe(
      'example.com',
    );
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });
  it('does not connect if a DNS answer contains a private address', async () => {
    (dns.lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.2', family: 4 },
    ]);
    await expect(
      postCallExport('https://example.com', '{}', {}),
    ).rejects.toThrow('Blocked');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    'http://example.com',
    'https://user:password@example.com',
    'https://[::1]/',
  ])('rejects unsafe destination %s', async (url) => {
    await expect(postCallExport(url, '{}', {})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('returns redirect status without following the redirect', async () => {
    (request as unknown as jest.Mock).mockImplementation(
      (_url, _options, receive) => ({
        on: jest.fn(),
        end: () =>
          receive({
            statusCode: 302,
            headers: { location: 'https://127.0.0.1' },
            destroy: jest.fn(),
          }),
      }),
    );
    expect(await postCallExport('https://example.com', '{}', {})).toBe(302);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
