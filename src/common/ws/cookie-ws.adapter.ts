import type { IncomingMessage } from 'http';
import { WsAdapter } from '@nestjs/platform-ws';
import type { WebSocket } from 'ws';

export type AuthenticatedWebSocket = WebSocket & {
  handshakeRequest?: IncomingMessage;
  /** Mensagens chegadas antes do gateway registrar seus listeners */
  __earlyMessages?: Array<{ data: unknown; isBinary: boolean }>;
  __detachEarlyBuffer?: () => void;
};

type ClientConnectHandler = (client: AuthenticatedWebSocket) => void;

/** Keeps the HTTP upgrade request available to gateways for cookie auth. */
export class CookieWsAdapter extends WsAdapter {
  bindClientConnect(server: any, callback: ClientConnectHandler) {
    server.on(
      'connection',
      (client: AuthenticatedWebSocket, request: IncomingMessage) => {
        client.handshakeRequest = request;

        // Discadores (Twilio Media Streams, CallFlex etc.) enviam os frames
        // de identificação imediatamente ao abrir o WS — antes do
        // handleConnection (async) registrar listeners. Bufferiza desde o
        // handshake; o gateway consome e desanexa após criar o adapter.
        if ((request.url || '').includes('/ws/dialer')) {
          const early: Array<{ data: unknown; isBinary: boolean }> = [];
          client.__earlyMessages = early;
          const handler = (data: unknown, isBinary: boolean) =>
            early.push({ data, isBinary });
          client.on('message', handler);
          client.__detachEarlyBuffer = () => client.off('message', handler);
        }

        callback(client);
      },
    );
  }
}
