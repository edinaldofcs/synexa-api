import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { publicFetch } from './public-http';
import { resolvePublicHttpUrl } from './ssrf-guard';
jest.mock('./ssrf-guard', () => ({ resolvePublicHttpUrl: jest.fn() }));
describe('pinned public HTTP transport', () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      if (req.url === '/large') {
        res.end(Buffer.alloc(11 * 1024 * 1024));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://public.invalid:${(server.address() as AddressInfo).port}`;
    (resolvePublicHttpUrl as jest.Mock).mockImplementation(
      async (url: string) => ({
        url: new URL(url),
        addresses: [{ address: '127.0.0.1', family: 4 }],
      }),
    );
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jest.clearAllMocks();
  });
  it('pins the connection without resolving the hostname again and preserves Host', async () => {
    const response = await publicFetch(base, {
      headers: { Host: 'internal.invalid' },
    });
    expect(await response.json()).toEqual({ host: new URL(base).host });
    expect(resolvePublicHttpUrl).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects instead of following a metadata destination', async () => {
    await expect(publicFetch(`${base}/redirect`)).rejects.toThrow('redirects');
  });
  it('bounds response data', async () => {
    const response = await publicFetch(`${base}/large`);
    await expect(response.arrayBuffer()).rejects.toThrow('size limit');
  });
  it('aborts while DNS validation is pending', async () => {
    (resolvePublicHttpUrl as jest.Mock).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = publicFetch(base, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
