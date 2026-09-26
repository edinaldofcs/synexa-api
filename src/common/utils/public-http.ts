import { Readable, Transform } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import { resolvePublicHttpUrl } from './ssrf-guard';

/** Bounded HTTP transport for tenant-controlled destinations. DNS is resolved once. */
export async function publicFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  const { url, addresses } = await Promise.race([
    resolvePublicHttpUrl(
      String(input),
      process.env.ENVIRONMENT === 'development',
    ),
    cancelled,
  ]).finally(() => signal.removeEventListener('abort', abort));
  signal.throwIfAborted();
  const selected = addresses[0];
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  // The destination determines Host; callers cannot redirect virtual hosting.
  delete headers.host;
  delete headers.connection;
  headers['accept-encoding'] = 'identity';
  let body: string | Uint8Array | undefined;
  if (typeof init.body === 'string') body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
  else if (ArrayBuffer.isView(init.body))
    body = new Uint8Array(
      init.body.buffer,
      init.body.byteOffset,
      init.body.byteLength,
    );
  else if (init.body != null)
    throw new Error('Unsupported outbound request body');
  const maxBytes = 10 * 1024 * 1024;
  if (body && Buffer.byteLength(body) > maxBytes)
    throw new Error('Outbound request exceeds size limit');
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: init.method || 'GET',
        headers,
        signal,
        agent: false,
        // Keep URL hostname for Host and TLS certificate verification, pin only DNS.
        lookup: (_host, _options, callback: any) =>
          _options.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
      },
      (response) => {
        const status = response.statusCode || 502;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error('Outbound redirects are not allowed'));
          return;
        }
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            resultHeaders.set(
              key,
              Array.isArray(value) ? value.join(', ') : value,
            );
        }
        let length = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            length += chunk.length;
            callback(
              length > maxBytes
                ? new Error('Outbound response exceeds size limit')
                : null,
              chunk,
            );
          },
        });
        response.on('error', (error) => bounded.destroy(error));
        bounded.on('close', () => response.destroy());
        const noBody =
          [204, 205, 304].includes(status) ||
          init.method?.toUpperCase() === 'HEAD';
        if (noBody) response.resume();
        else response.pipe(bounded);
        resolve(
          new Response(
            noBody
              ? null
              : (Readable.toWeb(bounded) as ReadableStream<Uint8Array>),
            {
              status,
              statusText: response.statusMessage,
              headers: resultHeaders,
            },
          ),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}
