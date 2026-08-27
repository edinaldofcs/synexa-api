import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import { AudioSocketAdapter } from '../adapters/audiosocket/audiosocket.adapter';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';
import { AsteriskAmiService } from './asterisk-ami.service';

/**
 * Ingresso de transporte AudioSocket do Asterisk.
 *
 * Dialplan recomendado:
 *   same => n,Dial(AudioSocket/<host>:<port>/${UNIQUEID})
 *
 * Como o protocolo não entrega variáveis de dialplan, o DID/cliente é
 * resolvido via AMI Getvar (SYNEXA_CLIENT_ID / SYNEXA_AGENT_STEP /
 * SYNEXA_DID) a partir do canal identificado.
 */
@Injectable()
export class AudioSocketServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioSocketServerService.name);
  private server: net.Server | null = null;
  private port: number;
  private enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly amiService: AsteriskAmiService,
  ) {
    this.port = this.configService.get<number>('AUDIOSOCKET_PORT') || 8090;
    this.enabled =
      this.configService.get<boolean>('AUDIOSOCKET_ENABLED') ?? false;
  }

  public onModuleInit(): void {
    if (this.enabled) {
      this.start();
    }
  }

  public onModuleDestroy(): void {
    this.stop();
  }

  public start(): void {
    if (this.server) return;

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(
        `📞 [AudioSocket] Servidor TCP escutando em 0.0.0.0:${this.port}`,
      );
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.log('🛑 [AudioSocket] Servidor encerrado');
    }
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    const adapter = new AudioSocketAdapter(socket);

    const channelId = await this.waitForChannelId(adapter);
    if (!channelId || !socket.writable) {
      socket.destroy();
      return;
    }

    try {
      // Roteamento: DID/SYNEXA_* via AMI -> telephony_endpoints
      const channelVars = await this.amiService.getChannelVariables(channelId, [
        'SYNEXA_CLIENT_ID',
        'SYNEXA_AGENT_STEP',
        'SYNEXA_DID',
        'CDR(dnid)',
        'EXTEN',
      ]);

      const didNumber =
        channelVars['SYNEXA_DID'] ||
        channelVars['CDR(dnid)'] ||
        channelVars['EXTEN'] ||
        undefined;

      const route = await this.endpointResolver.resolve({
        didNumber,
        providerName: adapter.providerName,
        clientIdHint: channelVars['SYNEXA_CLIENT_ID'] || undefined,
        agentStepHint: channelVars['SYNEXA_AGENT_STEP'] || undefined,
      });

      if (!route) {
        this.logger.warn(
          `[AudioSocket] Chamada sem rota (channel=${channelId}, did=${didNumber}). Cadastre em telephony_endpoints.`,
        );
        adapter.hangup('no_route');
        return;
      }

      const agent = route.agent as Record<string, any> | null;
      if (agent?.interaction_mode === 'text') {
        adapter.hangup('agent_text_only');
        return;
      }

      const { session } = await this.voiceSessionFactory.create(
        adapter,
        route,
        {
          onAiHangupRequest: async () => {
            await this.amiService.hangupChannel(channelId);
          },
        },
      );

      this.logger.log(
        `📞 [AudioSocket] Sessão iniciada | canal=${channelId} | cliente=${route.client_id} | agente=${route.agent?.id ?? 'default'}`,
      );
      await session.start();
    } catch (err: any) {
      this.logger.error(
        `[AudioSocket] Erro ao processar chamada ${channelId}: ${err.message}`,
      );
      adapter.hangup('internal_error');
    }
  }

  /**
   * O primeiro frame do AudioSocket carrega o UUID do canal; aguarda
   * brevemente por ele antes de decidir rotear.
   */
  private async waitForChannelId(
    adapter: AudioSocketAdapter,
    timeoutMs = 3000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = adapter.metadata.channelId as string | undefined;
      if (id) return id;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }
}
