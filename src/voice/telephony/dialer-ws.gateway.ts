import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createHash } from 'crypto';
import { WebSocket, WebSocketServer as WsServer } from 'ws';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import { TelephonyAdapterFactory } from '../adapters/telephony-adapter.factory';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';

const IDENTIFICATION_TIMEOUT_MS = 5000;

/**
 * Ingresso WebSocket genérico para discadores SaaS com streaming nativo
 * (CallFlex, NexCore etc.).
 *
 * Contrato Synexa v1:
 *   Conexão: /ws/dialer?provider=callflex&token=<secret>
 *   Auth:    sha256(token + pepper) == telephony_endpoints.inbound_secret_hash
 *   Frame 1: JSON  { type:'start', call_id, from, did, variables }
 *   Mídia:   frames binários no formato de áudio configurado no endpoint
 *
 * Provedores novos: implementar `ITelephonyAdapter` e registrar no
 * `TelephonyAdapterFactory` — este ingresso é agnóstico do provedor.
 */
@WebSocketGateway({ path: '/ws/dialer' })
export class DialerWsIngress
  implements
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnModuleDestroy
{
  private readonly logger = new Logger(DialerWsIngress.name);
  private readonly wsTokenPepper: string;

  @WebSocketServer()
  private server!: WsServer;

  private readonly sessions = new Map<
    WebSocket,
    { adapter: ITelephonyAdapter; close: () => void }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly adapterFactory: TelephonyAdapterFactory,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
  ) {
    this.wsTokenPepper =
      this.configService.get<string>('TELEPHONY_WS_TOKEN_PEPPER') || '';
  }

  public async handleConnection(clientWs: WebSocket): Promise<void> {
    try {
      const request = (clientWs as any).handshakeRequest as
        | {
            url?: string;
            headers?: Record<string, string | string[] | undefined>;
          }
        | undefined;
      const url = new URL(request?.url || '/', 'http://synexa.local');
      const provider = (
        url.searchParams.get('provider') || 'callflex'
      ).toLowerCase();

      const headerAuth = String(
        request?.headers?.['authorization'] || '',
      ).replace(/^Bearer\s+/i, '');
      const token = url.searchParams.get('token') || headerAuth;

      if (!token) {
        this.logger.warn('[DialerWS] Conexão sem token. Rejeitada.');
        clientWs.close(4401, 'unauthorized');
        return;
      }

      // Mensagens que o discador mandou antes daqui (bufferizadas pelo
      // CookieWsAdapter desde o handshake) são reproduzidas no adapter.
      const earlyMessages = (clientWs as any).__earlyMessages as
        | Array<{ data: unknown; isBinary: boolean }>
        | undefined;

      const tokenHash = createHash('sha256')
        .update(`${token}${this.wsTokenPepper}`)
        .digest('hex');

      // Pré-validação do segredo antes de abrir o streaming de mídia
      const preRoute =
        await this.endpointResolver.resolveBySecretHash(tokenHash);
      if (!preRoute) {
        this.logger.warn('[DialerWS] Token sem endpoint habilitado.');
        (clientWs as any).__detachEarlyBuffer?.();
        clientWs.close(4403, 'no_route');
        return;
      }

      // Única instância do adapter: identifica caller/did/variáveis
      const adapter = this.adapterFactory.create(provider, {
        wsSocket: clientWs,
        metadata: {
          ...(preRoute.didNumber ? { didNumber: preRoute.didNumber } : {}),
          uniqueId: `dialer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        },
        audioFormat: normalizeAudioFormat(preRoute.audioFormat),
      });

      // Mesmo tick da criação: sem janela de perda nem duplicação
      (clientWs as any).__detachEarlyBuffer?.();
      for (const { data, isBinary } of earlyMessages || []) {
        adapter.handleRawMessage?.(data, isBinary);
      }

      await adapter.waitForIdentification?.(IDENTIFICATION_TIMEOUT_MS);

      // Desconexão durante o setup async: sem esta checagem a sessão seria
      // criada com o WS já fechado (Gemini conectado, conversa presa em active)
      if ((clientWs as { readyState?: number }).readyState !== WebSocket.OPEN) {
        this.logger.warn(
          '[DialerWS] Cliente desconectou durante a identificação; sessão abortada',
        );
        adapter.close?.();
        return;
      }

      // Refina a rota se o discador indicou outro DID no frame de start
      const identifiedDid = adapter.metadata.didNumber as string | undefined;
      const route =
        identifiedDid && identifiedDid !== preRoute.didNumber
          ? await this.endpointResolver.resolveBySecretHash(
              tokenHash,
              identifiedDid,
            )
          : preRoute;

      if (!route) {
        this.logger.warn(
          `[DialerWS] Nenhum endpoint habilitado para did=${identifiedDid}.`,
        );
        clientWs.close(4403, 'no_route');
        return;
      }

      if ((route.agent as any)?.interaction_mode === 'text') {
        adapter.close?.();
        return;
      }

      if ((clientWs as { readyState?: number }).readyState !== WebSocket.OPEN) {
        this.logger.warn(
          '[DialerWS] Cliente desconectou durante a resolução de rota; sessão abortada',
        );
        adapter.close?.();
        return;
      }

      const { session } = await this.voiceSessionFactory.create(
        adapter,
        route,
        {
          // Habilita a tool nativa finalizar_chamada; hangup encerra o WS
          // (CallFlex: frame hangup; Twilio: devolve ao TwiML)
          onAiHangupRequest: async () => {
            await adapter.hangup('ai_requested');
          },
        },
      );
      this.sessions.set(clientWs, {
        adapter,
        close: () => void session.end(),
      });

      this.logger.log(
        `📞 [DialerWS] Sessão iniciada | provedor=${provider} | cliente=${route.client_id} | chamada=${adapter.id}`,
      );
      await session.start();
    } catch (err: any) {
      this.logger.error(`[DialerWS] Falha na conexão: ${err.message}`);
      try {
        clientWs.close(1011, 'internal_error');
      } catch {
        /* noop */
      }
    }
  }

  public handleDisconnect(clientWs: WebSocket): void {
    const entry = this.sessions.get(clientWs);
    if (entry) {
      entry.close();
      this.sessions.delete(clientWs);
    }
  }

  public onModuleDestroy(): void {
    for (const [, entry] of this.sessions) {
      entry.adapter.close?.();
    }
    this.sessions.clear();
  }
}

function normalizeAudioFormat(
  format: string,
): 'g711_ulaw' | 'g711_alaw' | 'pcm_8k' | 'pcm_16k' {
  switch (format) {
    case 'g711_alaw':
      return 'g711_alaw';
    case 'pcm_8k':
    case 'slin_8k':
      return 'pcm_8k';
    case 'pcm_16k':
      return 'pcm_16k';
    default:
      return 'g711_ulaw';
  }
}
