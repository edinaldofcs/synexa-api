import type { IncomingMessage } from 'http';
import { WsAdapter } from '@nestjs/platform-ws';
import type { WebSocket } from 'ws';

export type AuthenticatedWebSocket = WebSocket & {
  handshakeRequest?: IncomingMessage;
};

type ClientConnectHandler = (client: AuthenticatedWebSocket) => void;

/** Keeps the HTTP upgrade request available to gateways for cookie auth. */
export class CookieWsAdapter extends WsAdapter {
  bindClientConnect(server: any, callback: ClientConnectHandler) {
    server.on(
      'connection',
      (client: AuthenticatedWebSocket, request: IncomingMessage) => {
        client.handshakeRequest = request;
        callback(client);
      },
    );
  }
}
